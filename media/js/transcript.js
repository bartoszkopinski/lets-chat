//
// Roomlist
//
var TranscriptView = Backbone.View.extend({
    el: '#transcript',
    initialize: function(options) {
        var self = this;
        this.options = options;
        //
        // Models
        //
        this.messages = new MessagesCollection();
        //
        // Templates
        //
        this.messageTemplate = $('#js-tmpl-message').html();
        //
        // Get them plugins
        //
        this.plugins = {};
        $.get('/plugins/replacements.json', function(json) {
            self.plugins.replacements = json;
        });
        $.get('/plugins/emotes.json', function(json) {
            self.plugins.emotes = json;
        });
        //
        // Model Events
        //
        this.messages.bind('add', function(message) {
            self.addMessage(message.toJSON());
        });
        //
        // Populate messages
        //
        _.each(options.messages.reverse(), function(message) {
            self.messages.add(message);
        });
    },
    formatContent: function(text) {
        return window.utils.message.format(text, this.plugins);
    },
    addMessage: function(message) {
        if (message.text.match(/\n/ig)) {
            message.paste = true;
        }
        var $html = $(Mustache.to_html(this.messageTemplate, message).trim());
        var $text = $html.find('.text');
        $text.html(this.formatContent($text.html()));
        this.$('.messages').append($html);
    },
});
