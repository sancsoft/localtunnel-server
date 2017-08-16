import log from 'bookrc';
import express from 'express';
import tldjs from 'tldjs';
import on_finished from 'on-finished';
import Debug from 'debug';
import http_proxy from 'http-proxy';
import http from 'http';
import Promise from 'bluebird';

import Proxy from './proxy';
import rand_id from './lib/rand_id';
import BindingAgent from './lib/BindingAgent';

var winston = require('winston');

var logger = new (winston.Logger) ({
    transports: [
        new (winston.transports.File) ({
            filename: 'serverLog.txt',
            maxsize: 10000000,
            maxFiles: 5,
            json: false
        })
    ]
});

const debug = Debug('localtunnel:server');

const proxy = http_proxy.createProxyServer({
    target: 'http://localtunnel.github.io'
});

proxy.on('error', function(err) {
    log.error(err);
});

proxy.on('proxyReq', function(proxyReq, req, res, options) {
    // rewrite the request so it hits the correct url on github
    // also make sure host header is what we expect
    proxyReq.path = '/www' + proxyReq.path;
    proxyReq.setHeader('host', 'localtunnel.github.io');

    logger.info("Proxy Path: ", proxyReq.path);
    logger.info("Proxy Headers: ", proxyReq.headers);
});

const PRODUCTION = process.env.NODE_ENV === 'production';

// id -> client http server
const clients = Object.create(null);

// proxy statistics
const stats = {
    tunnels: 0
};

// handle proxying a request to a client
// will wait for a tunnel socket to become available
function maybe_bounce(req, res, sock, head) {
    // without a hostname, we won't know who the request is for
    const hostname = req.headers.host;

    logger.info("Hostname: ", hostname);

    if (!hostname) {
        logger.error("No hostname defined");
        return false;
    }

    const subdomain = tldjs.getSubdomain(hostname);

    logger.info("Subdomain: ", subdomain);

    if (!subdomain) {
        logger.error("No subdomain defined");
        return false;
    }

    const client = clients[subdomain];

    // no such subdomain
    // we use 502 error to the client to signify we can't service the request
    if (!client) {
        logger.error("No client defined.");
        if (res) {
            logger.error("No active client for: ", subdomain);
            res.statusCode = 502;
            res.end(`no active client for '${subdomain}'`);
            req.connection.destroy();
        }
        else if (sock) {
            logger.info("Destroying sock: ", sock);
            sock.destroy();
        }

        return true;
    }

    let finished = false;
    if (sock) {
        logger.info("Finishing sock.");
        sock.once('end', function() {
            finished = true;
        });
    }
    else if (res) {
        // flag if we already finished before we get a socket
        // we can't respond to these requests
        on_finished(res, function(err) {
            logger.info("Finished before obtained socket");
            finished = true;
            req.connection.destroy();
        });
    }
    // not something we are expecting, need a sock or a res
    else {
        logger.info("No sock or res, destroying connection");
        req.connection.destroy();
        return true;
    }

    // TODO add a timeout, if we run out of sockets, then just 502

    // get client port
    client.next_socket(async (socket) => {
        logger.info("Getting client port.");

        // the request already finished or client disconnected
        if (finished) {
            logger.info("Request finished or client disconnected, exiting");
            return;
        }

        // happens when client upstream is disconnected (or disconnects)
        // and the proxy iterates the waiting list and clears the callbacks
        // we gracefully inform the user and kill their conn
        // without this, the browser will leave some connections open
        // and try to use them again for new requests
        // we cannot have this as we need bouncy to assign the requests again
        // TODO(roman) we could instead have a timeout above
        // if no socket becomes available within some time,
        // we just tell the user no resource available to service request
        else if (!socket) {
            if (res) {
                res.statusCode = 504;
                logger.error("Client upstream disconnected, ending response with status code: ", res.statusCode);
                res.end();
            }

            if (sock) {
                logger.info("No socket, destroying sock: ", sock);
                sock.destroy();
            }

            logger.info("No socket, destroying connection");
            req.connection.destroy();
            return;
        }

        // websocket requests are special in that we simply re-create the header info
        // and directly pipe the socket data
        // avoids having to rebuild the request and handle upgrades via the http client
        if (res === null) {
            const arr = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
            for (let i=0 ; i < (req.rawHeaders.length-1) ; i+=2) {
                arr.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}`);
            }

            arr.push('');
            arr.push('');

            logger.info("Response is null, re-creating header info");

            socket.pipe(sock).pipe(socket);
            socket.write(arr.join('\r\n'));

            await new Promise((resolve) => {
                logger.info("Response is null, waiting for a new promise");
                socket.once('end', resolve);
            });

            return;
        }

        // regular http request

        const agent = new BindingAgent({
            socket: socket
        });

        const opt = {
            path: req.url,
            agent: agent,
            method: req.method,
            headers: req.headers
        };

        await new Promise((resolve) => {
            logger.info("Waiting for a new promise to resolve");

            // what if error making this request?
            const client_req = http.request(opt, function(client_res) {
                // write response code and headers
                res.writeHead(client_res.statusCode, client_res.headers);

                logger.info("Writing client response");

                client_res.pipe(res);
                on_finished(client_res, function(err) {
                    logger.info("Finished piping client response");
                    resolve();
                });
            });

            // happens if the other end dies while we are making the request
            // so we just end the req and move on
            // we can't really do more with the response here because headers
            // may already be sent
            client_req.on('error', (err) => {
                logger.error("Destroying connection, client request error: ", err);
                req.connection.destroy();
            });

            req.pipe(client_req);
        });
    });

    return true;
}

// create a new tunnel with `id`
function new_client(id, opt, cb) {
    logger.info("Creating a new tunnel, id: ", id);

    // can't ask for id already is use
    // TODO check this new id again
    if (clients[id]) {
        id = rand_id();
    }

    const popt = {
        id: id,
        max_tcp_sockets: opt.max_tcp_sockets
    };

    const client = Proxy(popt);

    // add to clients map immediately
    // avoiding races with other clients requesting same id
    clients[id] = client;

    client.on('end', function() {
        logger.info("Client ended, deleting client id:", id);
        --stats.tunnels;
        delete clients[id];
    });

    client.start((err, info) => {
        if (err) {
            logger.error("Starting client error: ",err);
            logger.error("Deleting client id: ", id);
            delete clients[id];
            cb(err);
            return;
        }

        ++stats.tunnels;

        info.id = id;
        logger.info("Starting client: ", info);
        cb(err, info);
    });
}

module.exports = function(opt) {
    opt = opt || {};

    const schema = opt.secure ? 'https' : 'http';

    const app = express();

    app.get('/', function(req, res, next) {
        if (req.query['new'] === undefined) {
            return next();
        }

        const req_id = rand_id();
        debug('making new client with id %s', req_id);
        new_client(req_id, opt, function(err, info) {
            logger.info("Making new client with id: ", req_id);
            if (err) {
                res.statusCode = 500;
                logger.error("Making new client error: ", err);
                logger.error("Ending response");
                return res.end(err.message);
            }

            const url = schema + '://' + req_id + '.' + req.headers.host;
            info.url = url;
            logger.info("Created new client: ", info);
            res.json(info);
        });
    });

    app.get('/', function(req, res, next) {
        logger.info("Response redirecting to https://localtunnel.github.io/www/");
        res.redirect('https://localtunnel.github.io/www/');
    });

    // TODO(roman) remove after deploying redirect above
    app.get('/assets/*', function(req, res, next) {
        logger.info("Request assets");
        proxy.web(req, res);
    });

    // TODO(roman) remove after deploying redirect above
    app.get('/favicon.ico', function(req, res, next) {
        logger.info("Request favicon.ico");
        proxy.web(req, res);
    });

    app.get('/api/status', function(req, res, next) {
        res.json({
            tunnels: stats.tunnels,
            mem: process.memoryUsage(),
        });
        logger.info("Request status");
    });

    app.get('/:req_id', function(req, res, next) {
        const req_id = req.params.req_id;

        // limit requested hostnames to 63 characters
        if (! /^[a-z0-9]{4,63}$/.test(req_id)) {
            const err = new Error('Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.');
            err.statusCode = 403;
            logger.error("Subdomain error: ", err);
            return next(err);
        }

        debug('making new client with id %s', req_id);
        new_client(req_id, opt, function(err, info) {
            if (err) {
                logger.error("Creating new client error: ", err);
                return next(err);
            }

            const url = schema + '://' + req_id + '.' + req.headers.host;
            info.url = url;
            logger.info("Creating new client with id: ", req_id, ", info: ", info);
            res.json(info);
        });

    });

    app.use(function(err, req, res, next) {
        const status = err.statusCode || err.status || 500;

        logger.error("Response error: ", status);
        res.status(status).json({
            message: err.message
        });
    });

    const server = http.createServer();

    server.on('request', function(req, res) {
        logger.info("Making server request");

        req.on('error', (err) => {
            logger.error("Server request error:", err);
            console.error('request', err);
        });

        res.on('error', (err) => {
            logger.error("Server response error:", err);
            console.error('response', err);
        });

        debug('request %s', req.url);
        if (maybe_bounce(req, res, null, null)) {
            logger.info("Server request, calling maybe_bounce, url: ", req.url);
            return;
        };

        app(req, res);
    });

    server.on('upgrade', function(req, socket, head) {
        req.on('error', (err) => {
            logger.error("Server upgrade request error: ", err);
            console.error('ws req', err);
        });

        socket.on('error', (err) => {
            logger.error("Server upgrade socket error: ", err);
            console.error('ws socket', err);
        });

        if (maybe_bounce(req, null, socket, head)) {
            logger.info("Server upgrade, calling maybe_bounce");
            return;
        };

        logger.info("Server upgrade, destroying socket: ", socket.address().address,":", socket.address().port);

        socket.destroy();
    });

    return server;
};
