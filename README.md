# Introduction

Delphinus monitors are served as relay systems for Delphinus Cross Chain solution.

## Install supervisord:
[Supervisor](https://github.com/Supervisor/supervisor) is a client/server system that allows its users to monitor and control a number of processes on UNIX-like operating systems. We use supervisor to monitor process.

The server piece of supervisor is named **supervisord**.  It is responsible for starting child programs at its own invocation, responding to commands from clients, restarting crashed or exited subprocesses, logging its subprocess stdout and stderr output, and generating and handling “events” corresponding to points in subprocess lifetimes.

Here we take Ubuntu for example, you can get more info [here](http://supervisord.org/).

```bash
# install Supervisord
sudo apt-get install -y supervisor
```

## Start Monitor
```bash
sh run.sh
```

## Browsing

Enter `localhost:9001` in a browser to access the server. Enter the username and the password to the web interface. Switch to root account may help solving problems when you run the commands above.

## Start mongo db
mongod --fork --logpath mongo/monitor.log --dbpath mongo
