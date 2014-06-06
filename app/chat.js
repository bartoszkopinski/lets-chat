//
// Let's Chat Sockets
//

var _ = require('underscore');
var hash = require('node_hash');
var moment = require('moment');
var connectSession = require('connect').middleware.session.Session;
var socketIO = require('socket.io');
var passportSocketIO = require('passport.socketio');

var models = require('./models/models.js');

//
// Chat
//
var ChatServer = function (config, server, sessionStore) {

    var self = this;

    self.config = config;

    this.rooms = {};

    // Moment Format
    moment.calendar.sameDay = 'LT';

    //
    // Listen
    //
    this.listen = function () {

        // Setup socket.io
        this.io = socketIO.listen(server);
        this.io.set('log level', 0);

        //
        // Connection
        //
        this.io.sockets.on('connection', function(client) {

            //
            // Message History
            //
            client.on('room:messages:get', function(req, fn) {
                // TODO: Make this less shitty
                var today = new Date()
                req.room = req.room || false;
                req.from = req.from || false;
                req.since = req.since || new Date(today).setDate(today.getDate() - 7);
                var query = models.message.find({});
                if (req.room) {
                    query.where('room', req.room);
                }
                if (req.from) {
                    query.where('_id').gt(req.from);
                }
                if (req.since) {
                    query.where('posted').gte(req.since);
                }
                query
                  .sort({ posted: -1 })
                  .exec(function (err, docs) {
                    if (err) {
                        // Couldn't get message or something
                        return;
                    }
                    var messages = [];
                    if (docs) {
                        docs.forEach(function (message) {
                            messages.push({
                                room: message.room,
                                id: message._id,
                                text: message.text,
                                posted: message.posted,
                            });
                        });
                    }
                    messages.reverse();
                    // Is there a callback?
                    if (fn) {
                        fn(messages);
                    } else {
                        client.emit('room:messages:new', messages);
                    }
                });
            });

            //
            // New Message
            //
            client.on('room:messages:new', function(data) {
                var message = new models.message({
                    room: data.room,
                    text: data.text
                });
                message.save(function(err, message) {
                    if (err) {
                        // Shit we're on fire!
                        return;
                    }
                    var outgoingMessage = {
                        id: message._id,
                        text: message.text,
                        posted: message.posted,
                        room: message.room
                    }
                    self.io.sockets.in(message.room).emit('room:messages:new', outgoingMessage);
                    // Let's save the last message timestamp for the room
                    // TODO: Maybe define a helper in the Room schema
                    models.room.findOne({
                        '_id': message.room
                    }, function(err, room) {
                        if (err) {
                            // Shit son...
                            return;
                        }
                        room.lastActive = message.posted;
                        room.save();
                        self.io.sockets.emit('room:update', {
                            id: room._id,
                            lastActive: room.lastActive
                        });
                    });
                });
            });

            //
            // Join Room
            //
            client.on('room:join', function(id, fn) {
                models.room.findById(id, function(err, room) {
                    if (err) {
                        // Oh shit
                        return;
                    }
                    if (!room) {
                        // No room bro
                        return;
                    }
                    client.join(id);
                    // Send back Room meta to client
                    if (fn) {
                        fn({
                            id: room._id,
                            name: room.name,
                            description: room.description
                        });
                    }
                });
            });

            //
            // Get Room Files
            //
            client.on('room:files:get', function(query) {
                models.file.find({ room: query.room })
                  .exec(function (err, files) {
                        if (err) {
                            // Couldn't get files or something
                            return;
                        }
                        _.each(files, function(file) {
                            var filePath = file._id + '/' + encodeURIComponent(file.name);
                            var url = !self.config.s3 ? '/files/' + filePath : 'https://' + config.s3.bucket + '.s3-' + config.s3.region + '.amazonaws.com/' + filePath;
                            client.emit('room:files:new', {
                                url: url,
                                id: file._id,
                                name: file.name,
                                type: file.type,
                                size: Math.floor(file.size / 1024),
                                uploaded: file.uploaded,
                                room: file.room
                            });
                        });
                });
            });

            //
            // Create Room
            //
            client.on('rooms:create', function(room, fn) {
              var newroom = new models.room({
                name: room.name,
                description: room.description
              });
              newroom.save(function (err, room) {
                if (err) {
                  // We derped somehow
                  return;
                }
                self.io.sockets.emit('rooms:new', {
                    id: room._id,
                    name: room.name,
                    description: room.description,
                    lastActive: room.lastActive
                });
              });
            });

            //
            // Roomlist request
            //
            client.on('rooms:get', function (query) {
                models.room.find().exec(function(err, rooms) {
                    if (err) {
                        // Couldn't get rooms
                        return;
                    }
                    _.each(rooms, function(room) {
                        client.emit('rooms:new', {
                            id: room._id,
                            name: room.name,
                            description: room.description,
                            lastActive: room.lastActive
                        });
                    });
                });
            });

            //
            // Update Room
            //
            client.on('room:update', function(data) {
                models.room.findOne({
                    _id: data.id
                }).exec(function (err, room) {
                    if (err) {
                        // Oh damn
                        return;
                    }
                    if (!room) {
                        // What happened to our room?
                        return;
                    }
                    room.name = data.name;
                    room.description = data.description;
                    room.save(function (err) {
                        if (err) {
                            // Couldn't save :(
                            return;
                        }
                        // Let's let everyone know
                        self.io.sockets.emit('room:update', {
                            id: room._id,
                            name: room.name,
                            description: room.description
                        });
                    });
                });
            });

            //
            // Delete Room
            //
            client.on('room:delete', function(id) {
                models.room.findOne({
                    _id: id
                }).exec(function (err, room) {
                    if (err) {
                        // Oh damn
                        return;
                    }
                    if (!room) {
                        // What happened to our room?
                        return;
                    }
                    self.io.sockets.in(id).emit('room:remove', id);
                    self.io.sockets.emit('rooms:remove', id)
                    room.remove();
                });
            });

        });

    };

    //
    // Utility method to send files from the express server
    //
    this.sendFile = function(file) {
        self.io.sockets.in(file.room).emit('room:files:new', file);
    };

    this.start = function () {
        // Setup listeners
        this.listen();
        return this;
    };

};

module.exports = ChatServer;
