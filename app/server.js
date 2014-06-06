//
// Let's Chat Frontend
//

var _ = require('underscore');
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var express = require('express');
var expressNamespace = require('express-namespace');
var mongoose = require('mongoose');
var mongoStore = require('connect-mongo')(express);
var swig = require('swig');
var cons = require('consolidate');
var hash = require('node_hash');
var moment = require('moment');
var passport = require('passport');
var LocalStrategy = require('passport-local').Strategy;
var knox = require('knox');

// App stuff
var ChatServer = require('./chat.js');

// Models
var models = require('./models/models.js');

// TODO: We should require login on all routes
var requireLogin = function(req, res, next) {
    // if (req.isAuthenticated()) {
        next();
    // } else {
        // res.redirect('/login?next=' + req.path);
    // }
};

//
// Web
//
var Server = function(config) {

    var self = this;

    self.config = config;

    // Mongo URL
    self.mongoURL = self.config.db_url || 'mongodb://'
        + self.config.db_user
        + ':' + self.config.db_password
        + '@' + self.config.db_host
        + ':' + self.config.db_port
        + '/' + self.config.db_name;

    // Create express app
    self.app = express();

    //
    // Configuration
    //
    self.app.configure(function() {

        // Body
        self.app.use(express.bodyParser());

        // Sessions
        self.sessionStore = new mongoStore({
            url: self.mongoURL
        });
        self.app.use(express.cookieParser());
        self.app.use(express.session({
            key: 'express.sid',
            cookie: {
                httpOnly: false // We have to turn off httpOnly for websockets
            },
            secret: self.config.cookie_secret,
            store: self.sessionStore
        }));

        // Auth
        self.app.use(passport.initialize());
        self.app.use(passport.session());

        // Templates
        swig.init({
            cache: !self.config.debug,
            root: 'templates',
            allowErrors: self.config.debug
        });
        self.app.engine('.html', cons.swig);
        self.app.set('view engine', 'html');
        self.app.set('views', 'templates');

        // Static
        self.app.use('/media', express.static(path.resolve('media')));

        // Router
        self.app.use(self.app.router);

    });

    //
    // Chat
    //
    self.app.get('/', requireLogin, function(req, res) {
        var vars = {
            media_url: self.config.media_url,
            host: self.config.hostname,
            port: self.config.port,
        }
        res.render('chat.html', vars);
    });


    //
    // Serve Plugins
    //
    self.app.namespace('/plugins', function() {
        if (self.config.plugins) {
            _.each(self.config.plugins, function(plugin) {
                self.app.get('/' + plugin.url, function(req, res) {
                    res.json(require('../' + self.config.plugins_dir + '/' + plugin.file));
                });
            });
        }
    });

    //
    // Ajax
    //
    self.app.namespace('/ajax', function() {
        //
        // File uploadin'
        // TODO: Some proper error handling
        self.app.post('/upload-file', requireLogin, function(req, res) {
            var moveUpload = function(path, newPath, callback) {
                fs.readFile(path, function(err, data) {
                    fs.writeFile(newPath, data, function(err) {
                        callback();
                    });
                });
            }
            // Loops through them files
            _.each(req.files, function(file) {
                var roomID = req.body.room;
                var file = file[0];
                var allowed_file_types = self.config.allowed_file_types;

                // Check MIME Type
                if (!_.include(allowed_file_types, file.type)) {
                    res.send({
                        status: 'error',
                        message: 'The MIME type ' + file.type + ' is not allowed'
                    });
                    return;
                }

                // Lets see if this room exists
                models.room.findOne({
                    '_id': roomID
                }).exec(function(err, room) {
                    if (err) {
                        // Danger zone!
                        res.send({
                            status: 'error',
                            message: 'Couldn\'t do the db query'
                        });
                        return;
                    }
                    // No such room?
                    if (!room) {
                        res.send({
                            status: 'error',
                            message: 'This room does not exist'
                        });
                        return;
                    }

                    // Save the file if all is well
                    new models.file({
                        name: file.name,
                        type: file.type,
                        size: file.size,
                        room: room._id
                    }).save(function(err, savedFile) {
                        var fileFolder = savedFile._id;
                        var filePath = fileFolder + '/' + encodeURIComponent(savedFile.name);
                        (!config.s3 ? function(callback) {
                            // if s3 config is not set, upload file to filesystem
                            // Let's move the upload now
                            moveUpload(file.path, self.config.uploads_dir + '/' + fileFolder, function(err) {
                                // Let the clients know about the new file
                                var url = '/files/' + filePath;
                                callback(null, url, savedFile);
                            });
                        } : function(callback) {
                            // otherwise, upload the file to S3
                            var client = knox.createClient({
                                key: self.config.s3.accessKeyId,
                                secret: self.config.s3.secretAccessKey,
                                region: self.config.s3.region,
                                bucket: self.config.s3.bucket
                            });
                            client.putFile(file.path, '/' + decodeURIComponent(filePath), {
                                'Content-Type': file.type,
                                'Content-Length': file.size
                            }, function (err, response) {
                                if (response.statusCode != 200) {
                                    callback('There was a problem with the server\'s S3 credentials.');
                                    return;
                                }
                                var url = 'https://' + client.urlBase + '/' + filePath;
                                callback(null, url, savedFile);
                            });
                        })(function(error, url, savedFile) {
                            // send the updated file to the chatserver
                            if (error) {
                                res.send({
                                    status: 'error',
                                    message: error
                                });
                                return;
                            }
                            self.chatServer.sendFile({
                                url: url,
                                id: savedFile._id,
                                name: savedFile.name,
                                type: savedFile.type,
                                size: Math.floor(savedFile.size / 1024),
                                uploaded: savedFile.uploaded,
                                room: room._id
                            });
                            res.send({
                                status: 'success',
                                message: savedFile.name + ' has been saved!',
                                url: url
                            });
                        });
                    });

                });
            });
        });
    });

    //
    // View files
    //
    self.app.get('/files/:id/:name', requireLogin, function(req, res) {
        models.file.findById(req.params.id, function(err, file) {
            if (err) {
                // Error
                res.send(500, 'Something went terribly wrong');
                return;
            }
            res.contentType(file.type);
            res.sendfile(self.config.uploads_dir + '/' + file._id);
        });
    });

    //
    // Transcripts
    //
    self.app.get('/transcripts/:room', requireLogin, function(req, res) {
        var fromDate = moment().subtract('days', 1).format("DDMMYYYY");
        var toDate = moment().format("DDMMYYYY");

        res.writeHead(301, {Location: '/transcripts/' + req.params.room + '/from/' + fromDate + '/to/' + toDate});
        res.end();
    });

    self.app.get('/transcripts/:room/from/:fromDate/to/:toDate', requireLogin, function(req, res) {
        //dates in url are in DDMMYYY format
        var dateParamPattern = /[0-9]{6}/;

        //check if dates in the parameters are 6 digit numbers
        if(!dateParamPattern.test(req.params.fromDate) ||
           !dateParamPattern.test(req.params.toDate)) {
           res.send(400, 'Invalid parameters');
        }

        var fromDate = moment(req.params.fromDate, "DDMMYYYY");
        var toDate = moment(req.params.toDate, "DDMMYYYY");

        // Lookup room
        models.room.findById(req.params.room, function(err, room) {
            if (err || !room) {
                // Error
                res.send(500, 'Something went wrong trying to lookup the room');
                return;
            }
            // Lookup messages
            // TODO: Maybe we should push message refs to room so we can use populate :|
            models.message.find({
                room: room._id
            }).select('-room -__v')
            .where('posted').gt(fromDate).lt(moment(new Date(toDate)).add('d', 1))
            .exec(function(err, docs) {
                if (err) {
                    // Whoopsie
                    return;
                }
                // Let's process some messages
                var messages = [];
                docs.forEach(function (message) {
                    messages.push({
                        id: message._id,
                        text: message.text,
                        posted: message.posted,
                        time: moment(message.posted).format('hh:mm DD-MM-YYYY')
                    });
                });
                res.render('transcript.html', {
                    media_url: self.config.media_url,
                    fromDate: moment(fromDate).format('dddd, MMM Do YYYY'),
                    toDate: moment(toDate).format('dddd, MMM Do YYYY'),
                    room: {
                        id: room._id,
                        name: room.name,
                        description: room.description
                    },
                    messages: messages
                });
            });
        });
    });

    //
    // Start
    //
    self.start = function() {
        // Connect to mongo and start listening
        mongoose.connect(self.mongoURL, function(err) {
            if (err) throw err;
            // Go go go!
            if (!self.config.https) {
                // Create regular HTTP server
                self.server = http.createServer(self.app)
                  .listen(self.config.port, self.config.host);
            } else {
                // Setup HTTP -> HTTP redirect server
                var redirectServer = express();
                redirectServer.get('*', function(req, res){
                    res.redirect('https://' + req.host + ':' + self.config.https.port + req.path)
                })
                http.createServer(redirectServer)
                  .listen(self.config.port, self.config.host);
                // Create HTTPS server
                self.server = https.createServer({
                    key: fs.readFileSync(self.config.https.key),
                    cert: fs.readFileSync(self.config.https.cert)
                }, self.app).listen(self.config.https.port);
            }
            self.chatServer = new ChatServer(config, self.server, self.sessionStore).start();
        });
        return this;
    };

};

module.exports = Server;
