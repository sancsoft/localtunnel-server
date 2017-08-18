#!/bin/bash

port=$1

function localtunnel {
    ./bin/server --port $port
}

until localtunnel; do
printf "\nlocaltunnel server crashed, restarting server on port: $port\n\n"
sleep 2
done