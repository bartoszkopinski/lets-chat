//
// Letschatbro Chat Server
//

var _ = require('underscore');
var hash = require('node_hash');

var parseCookie = require('connect').utils.parseCookie;
var Session = require('connect').middleware.session.Session;

var models = require('./models/models.js');

var ChatServer = function (app, sessionStore) {

    var self = this;

    this.rooms = {};

    this.getUserList = function(room) {
        var users = {};
        var clients = self.io.sockets.clients(room);
        clients.forEach(function(client) {
            client.get('profile', function(err, profile)  {
                if (err) {
                    // No profile?
                    return;
                }
                users[profile.cid] = profile;
            });
        });
        return users;
    };

    this.listen = function () {
        
        //
        // Setup
        //
        this.io = require('socket.io').listen(app);
        this.io.set('log level', 0);
        this.io.set('authorization', function (data, accept) {
            // This function, courtesy of danielbaulig.de, will parse out session
            // info for connections.
            if (data.headers.cookie) {
                // if there is, parse the cookie
                data.cookie = parseCookie(data.headers.cookie);
                data.sessionID = data.cookie['express.sid'];
                data.sessionStore = sessionStore;
                sessionStore.get(data.sessionID, function (err, session) {
                    if (err || !session) {
                        accept('Error with Sessions', false);
                    } else {
                        data.session = new Session(data, session);
                        accept(null, true);
                    }
                });
            } else {
                // if there isn't, turn down the connection
                return accept('No cookie transmitted.', false);
            }
        });

        this.io.sockets.on('connection', function(client) {

            var hs = client.handshake;
            var userData = hs.session.user;
            
            //
            // Assign Client Profile
            //
            client.set('profile', {
                cid: hash.md5(client.id),
                id: userData._id,
                email: userData.email,
                firstName: userData.firstName,
                lastName: userData.lastName,
                displayName: userData.displayName,
                joined: userData.joined,
                avatar: hash.md5(userData.email)
            });

            
            //
            // Message History
            //
            client.on('messages:get', function(query) {
                var today = new Date()
                query.from = query.from || new Date(today).setDate(today.getDate() - 1)
                query.room = query.room || '';
                models.message.where('posted').gte(query.from)
                    .where('room').equals(query.room)
                    .sort('posted', -1).populate('owner')
                    .exec(function (err, docs) {
                        var messages = [];
                        if (docs) {
                            docs.forEach(function (message) {
                                messages.push({
                                    room: message.room,
                                    id: message._id,
                                    owner: message.owner._id,
                                    avatar: hash.md5(message.owner.email),
                                    name: message.owner.displayName,
                                    text: message.text,
                                    posted: message.posted
                                });
                            });
                        }
                        messages.reverse();
                        client.emit('messages:new', messages)
                });
            });
    
            //
            // New Message
            //
            client.on('messages:new', function(data) {
                var message = new models.message({
                    room: data.room,
                    owner: userData._id,
                    text: data.text
                });
                message.save(function(err, message) {
                    if (err) {
                        // Shit we're on fire!
                        return;
                    }
                    var outgoingMessage = {
                        id: message._id,
                        owner: message.owner,
                        avatar: hash.md5(userData.email),
                        name: userData.displayName,
                        text: message.text,
                        posted: message.posted,
                        room: message.room
                    }
                    self.io.sockets.in(message.room).emit('messages:new', outgoingMessage);
                });
            });

            //
            // Join Room
            //
            client.on('rooms:join', function(id, fn) {
                models.room.findById(id, function(err, room) {
                    if (err) {
                        // Oh shit
                        return;
                    }
                    client.join(id);
                    // Send back Room meta to client
                    fn({
                        id: room._id,
                        name: room.name,
                        description: room.description
                    });
                    // Hey everyone, look who it is
                    client.get('profile', function(err, profile) {
                        if (err) {
                            // Oh shit
                            return;
                        }
                        self.io.sockets.in(id).emit('users:new', {
                            room: id,
                            id: hash.md5(client.id),
                            avatar: profile.avatar,
                            name: profile.displayName,
                            safeName: profile.displayName.replace(/\W/g, '')
                        });
                    });
                });
            });
            
            //
            // Get Room Users
            //
            client.on('users:get', function(query) {
                _.each(self.io.sockets.clients(query.room), function(user) {
                    user.get('profile', function(err, profile) {
                        if (err) {
                            // What the what
                            return;
                        }
                        client.emit('users:new', {
                            room: query.room,
                            id: hash.md5(user.id),
                            avatar: profile.avatar,
                            name: profile.displayName,
                            safeName: profile.displayName.replace(/\W/g, '')
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
                description: room.description,
                owner: userData._id
              });
              newroom.save(function (err, room) {
                if (err) {
                  // We derped somehow
                  return;
                }
                self.io.sockets.emit('rooms:new', room);
              });
            });
            
            //
            // Roomlist request
            //
            client.on('rooms:list', function (query) {
                models.room.find().exec(function(err, rooms) {
                    if (err) {
                        // Couldn't get rooms
                        return;
                    }
                    _.each(rooms, function(room) {
                        client.emit('rooms:new', room);
                    });
                });
            });
            
            //
            // Leave Room
            //
            client.on('rooms:leave', function(room) {
                self.io.sockets.in(room).emit('users:leave', {
                    id: hash.md5(client.id),
                    room: room
                });
            });

            //
            // Disconnect
            //
            client.on('disconnect', function() {
                var rooms = self.io.sockets.manager.roomClients[client.id];
                _.each(rooms, function(status, room) {
                    room = room.replace('/', '');
                    self.io.sockets.in(room).emit('users:leave', {
                        id: hash.md5(client.id),
                        room: room
                    });
                });
            });

        });

    };

    this.start = function () {
        // Setup listeners
        this.listen();
		return this;
    };

};

module.exports = ChatServer;