SocketCluster Phaser Sample
======

This is an IO game engine built using SocketCluster and Phaser.
It is designed to scale across multiple processes to make use of all CPU cores on a machine.

The game world is divided into cells which will be distributed across available SC worker processes.
Basic initial tests indicate that this engine can scale linearly across available CPU cores - We've found that doubling
the number of worker processes allowed us to handle approximately double the number of bots whilst maintaining the average CPU ratio
per worker process at 50%.

Each cell in the world has its own instance of a cell controller (`cell.js`) - Ideally, this is where you should put all your back end game logic.
If you follow some simple structural guidelines, your code should automatically scale.
With this approach, you should be able to build very large worlds which can host many players.

If you've built a game using this engine, feel free to contribute back to this repo.
Also, feel free to get in touch with me directly by email (in my GitHub profile) if you'd like to chat, have feedback,
need advice or need help with a project.

Special thanks to the Percepts and Concepts Laboratory at Indiana University (http://cognitrn.psych.indiana.edu/) for sponsoring this project.

Jon

![sc-phaser-sample](https://raw.github.com/SocketCluster/sc-phaser-sample/master/public/img/sc-phaser-sample.png)

### Developing

The front-end code is in `public/index.html`, the back-end code is in `worker.js` and `cell.js`.
Read the comments in the code for more details about how it all works.

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

If you want to find out more about authentication and authorization, you may want to look into SC middleware: http://socketcluster.io/#!/docs/middleware-and-

To run the engine on multiple CPU cores, you just need to add more worker and broker processes.
You can do this by adding extra parameters to the node server command (`-w` is the number of worker processes and `-b` is the number of broker processes):

```
node server -w 3 -b 1
```

Unless your CPU/OS is particularly efficient with multitasking, you generally want to have one process per CPU core (to avoid sharing cores/context switching penalties). Note that in the example above, we are launching 4 processes in total; 3 workers and 1 broker.

Deciding on the correct ratio of workers to brokers is a bit of a balancing act and will vary based on your specific workload - You will have to try it out and watch your processes. When you launch the engine, SocketCluster will tell you the PIDs of your worker and broker processes.

Based on the rudimentary tests that I've carried out so far, I've found that you generally need more workers than brokers. The ratio of workers to brokers that seems
to work best for most use cases is approximately 2:1.

Also note that cell controllers (`cell.js`) will be evenly sharded across available workers. For this reason, it is highly recommended that you divide your world grid
in such a way that your number of worker processes and total number of cells share a common factor. So for example, if you have 3 workers, you can have a world grid with dimensions of 3000 * 3000 pixels made up of 3 cells of dimensions 1000 * 3000 (rectangular cells are fine; in fact, I highly encourage them since they are more efficient).

### More Info

It's still very early for this project, here are some things that still need improving:

- The front end needs some sort of motion smoothing since we don't want to set the WORLD_UPDATE_INTERVAL too high (for bandwidth reasons) and so the animation should be smoothed out on the front end.
- We need to make a custom SocketCluster codec specifically for this game engine to compress all outgoing messages to be as small as possible. Right now it's just using a general-purpose binary compression codec for SC - We should add another codec layer on top of this.
