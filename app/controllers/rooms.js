//
// Rooms Controller
//

var _ = require('underscore');

module.exports = function() {
    var app = this.app,
        middlewares = this.middlewares,
        models = this.models;

    //
    // Routes
    //
    app.get('/rooms', middlewares.requireLogin, function(req, res) {
        req.io.route('rooms:list');
    });
    app.post('/rooms', middlewares.requireLogin, function(req, res) {
        req.io.route('rooms:create');
    });
    app.delete('/rooms', middlewares.requireLogin, function(req, res) {
        req.io.route('rooms:delete');
    });

    //
    // Sockets
    //
    app.io.route('rooms', {
        create: function(req) {
            var data = req.data || req.body;
            models.room.create({
                owner: req.user._id,
                name: data.name,
                description: data.description
            }, function(err, room) {
                if (err) {
                    console.error(err);
                    req.io.respond(err, 400);
                    return;
                }
                req.io.respond(room, 201);
                app.io.broadcast('rooms:new', room);
            });
        },
        delete: function(req) {
            var data = req.data || req.body;
            var user = req.user._id;
        },
        list: function(req) {
            models.room
                .find()
                .exec(function(err, rooms) {
                if (err) {
                    console.error(err);
                    req.io.respond(err, 400);
                    return;
                }
                req.io.respond(rooms);
            });
        },
        update: function(req) {
            var id = req.data.id,
                name = req.data.name,
                description = req.data.description;
            models.room.findById(id, function(err, room) {
                if (err) {
                    // Oh noes, a bad thing happened!
                    console.error(err);
                    return;
                }
                if (!room) {
                    // WHY IS THERE NO ROOM!?
                    console.error('No room!');
                    req.io.respond();
                    return;
                }
                room.name = name;
                room.description = description;
                room.save(function(err, room) {
                    if (err) {
                        console.error(err);
                        req.io.respond(err, 400);
                        return;
                    }
                    req.io.broadcast('rooms:update', room.toJSON());
                    req.io.respond(room.toJSON(), 200);
                })
            });
        },
        join: function(req) {
            var id = req.data;
            models.room.findById(id, function(err, room) {
                if (err) {
                    // Problem? TODO: Figure out how to recover?
                    console.error(err);
                    return;
                }
                if (!room) {
                    // No room, no effect
                    console.error('No room!');
                    req.io.respond();
                    return;
                }
                req.io.join(room._id);
                req.io.respond(room.toJSON());
            });
        },
        leave: function(req) {
            var id = req.data;
            req.io.leave(id);
            req.io.respond();
        }
    });
    app.io.route('disconnect', function(req, res) {
        req.io.route('rooms:leave');
    });
}
