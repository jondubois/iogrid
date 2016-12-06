SocketCluster Phaser Sample
======

This is a demo using SocketCluster and Phaser.

![sc-phaser-sample](https://raw.github.com/SocketCluster/sc-phaser-sample/master/public/img/sc-phaser-sample.png)

### Developing

The front-end code is in `public/index.html`, the back-end code is in `worker.js`.

### Running

To run on your machine, you need to have Node.js `v6.0.0` or higher installed.
Then you can either clone this repo with Git using the command:

```
git clone git@github.com:SocketCluster/sc-phaser-sample.git
```

... Or you can download the zip: https://github.com/SocketCluster/sc-phaser-sample/archive/master.zip and extract it to a directory of your choice.

Once you have this repo setup in a `sc-phaser-sample` directory on your machine, you need to navigate to it using the terminal and then run:

```
npm install
```

Then (while still inside the `sc-phaser-sample` directory) you can launch the SocketCluster server using:

```
node server
```

To run the demo, navigate to `http://localhost:8000` in a browser - You should see a single colored circle which you can move around
using the arrow keys.

To test the multi-player functionality from your localhost:

Open up another browser window/tab to `http://localhost:8000` and put it side-by-side with the first window/tab - You should now
have two colored circles - Each one can be controlled from a different tab.

Note that while this demo demonstrates a few important optimizations, it is still not as optimized as it can be and it's not cheat-proof.
For production usage, among other things, you may want to setup a codec to convert your messages to binary packets when they are sent over the wire.
You may want to use https://github.com/SocketCluster/sc-codec-min-bin or make your own.

If you want to run the server on port 80, you'll need to run the SocketCluster server with `sudo node server -p 80`.

For more info about SocketCluster, visit http://socketcluster.io/.

If you want to find out more about authentication and authorization, you may want to look into SC middleware: http://socketcluster.io/#!/docs/middleware-and-authorization
