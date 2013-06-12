var _ = require('underscore');
var FeedParser = require('feedparser');
var request = require('request');
var async = require('async');
var $ = require('jquery');
var jsdom = require('jsdom');
var url = require('url');

var iframely = require("../../lib/iframely");
var iframelyMeta = require("../../lib/iframely-meta");

exports.getPluginUnusedMethods = function(pluginId, debugData) {

    var usedMethods = getAllUsedMethods(debugData);
    var pluginMethods = findAllPluginMethods(pluginId, debugData.plugins);

    return {
        mandatory: _.difference(pluginMethods.mandatory, usedMethods),
        skipped: _.difference(pluginMethods.skipped, usedMethods)
    };
};

exports.getErrors = function(debugData) {

    var errors = [];

    debugData.debug.forEach(function(level, levelIdx) {
        level.data.forEach(function(methodData) {
            if (methodData.error) {
                var methodId = methodData.method.pluginId + " - " + methodData.method.name;
                errors.push(methodId + ": " + methodData.error);
            }
        });
    });

    if (errors.length) {
        return errors;
    } else {
        return null;
    }
};

var MAX_FEED_URLS = 5;

var fetchFeedUrls = exports.fetchFeedUrls = function(feedUrl, cb) {

    var urls = [];

    var cbed = false;
    var _cb = function(error) {
        if (cbed) {
            return;
        }
        cbed = true;
        cb(error, urls);
    };

    request(feedUrl)
        .pipe(new FeedParser({addmeta: false}))
        .on('error', function(error) {
            _cb(error);
        })
        .on('readable', function () {
            var stream = this, item;
            while (item = stream.read()) {

                if (urls.length < MAX_FEED_URLS) {

                    urls.push(item.origlink || item.link);

                    if (MAX_FEED_URLS == urls.length) {
                        _cb();
                    }
                }
            }
        })
        .on('end', function() {
            _cb();
        });
};

exports.fetchUrlsByPageOnFeed = function(pageWithFeed, cb) {

    async.waterfall([

        function fetchPageMeta(cb) {
            iframelyMeta.getPageData(pageWithFeed, {
                oembed: false,
                fullResponse: false
            }, cb);
        },

        function findFeedUrl(data, cb) {
            var alternate = data.meta.alternate;

            var feeds;

            if (alternate) {

                if (!(alternate instanceof Array)) {
                    alternate = [alternate];
                }

                feeds = alternate.filter(function(o) {
                    return o.href && (o.type == "application/atom+xml" || o.type == "application/rss+xml");
                });
            }

            if (feeds && feeds.length > 0) {

                cb(null, feeds[0].href);

            } else {
                cb("No feeds found on " + pageWithFeed);
            }
        },

        fetchFeedUrls

    ], cb);
};

exports.fetchUrlsByPageAndSelector = function(page, selector, cb) {

    async.waterfall([

        function fetchPageBody(cb) {
            iframelyMeta.getPageData(page, {
                oembed: false,
                meta: false,
                fullResponse: true
            }, cb);
        },

        function createWindow(data, cb) {
            jsdom.env({
                html: data.fullResponse
            }, cb);
        },

        function(window, cb) {

            var $selector = $.create(window);

            var $links = $selector(selector);

            var urls = [];
            $links.each(function() {
                if (urls.length < MAX_FEED_URLS) {
                    var href = $(this).attr("href");
                    if (href) {
                        var href = url.resolve(page, href);
                        if (urls.indexOf(href) == -1) {
                            urls.push(href);
                        }
                    }
                }
            });

            if (urls.length) {
                cb(null, urls);
            } else {
                cb("No urls found on " + page + " using selector='" + selector + "'");
            }
        }
    ], cb);
};

function getAllUsedMethods(debugData) {

    var result = [];

    // Collect all meta sources.
    for(var metaKey in debugData.meta._sources) {
        findUsedMethods({findByMeta: metaKey}, debugData, result);
    }

    // Collect all links sources
    debugData.links.forEach(function(link) {
        findUsedMethods({link: link}, debugData, result);
    });

    return result;
}

function findAllPluginMethods(pluginId, plugins, result, skipped) {

    result = result || {
        mandatory: [],
        skipped: []
    };

    var plugin = plugins[pluginId];

    var skipMixins = [];
    var skipMethods = [];
    var tests = plugin.module.tests;
    tests && tests.forEach && tests.forEach(function(test) {
        if (test.skipMixins) {
            skipMixins = _.union(skipMixins, test.skipMixins);
        }
        if (test.skipMethods) {
            skipMethods = _.union(skipMethods, test.skipMethods);
        }
    });

    plugin.module.mixins && plugin.module.mixins.forEach(function(mixin) {

        if (!skipped && skipMixins.indexOf(mixin) == -1) {
            findAllPluginMethods(mixin, plugins, result);
        } else {
            findAllPluginMethods(mixin, plugins, result, true);
        }

    });

    iframely.PLUGIN_METHODS.forEach(function(method) {

        var methodId = pluginId + " - " + method;
        if (method in plugin.methods && result.mandatory.indexOf(methodId) == -1 && result.skipped.indexOf(methodId) == -1) {

            if (!skipped && skipMethods.indexOf(method) == -1) {
                result.mandatory.push(methodId);
            } else {
                result.skipped.push(methodId);
            }
        }
    });

    return result;
}

function findUsedMethods(options, debugData, result) {

    // Find debug data for specific link.

    var defaultContext = debugData.debug[0] && debugData.debug[0].context;
    defaultContext.request = true;
    defaultContext.$selector = true;

    result = result || [];

    debugData.debug.forEach(function(level, levelIdx) {
        if (options.maxLevel <= levelIdx) {
            return;
        }
        level.data.forEach(function(methodData) {

            if (!methodData.data) {
                return;
            }

            var resultData = methodData.data;
            if (!(resultData instanceof Array)) {
                resultData = [resultData];
            }

            resultData.forEach(function(l) {

                var good = false;
                if (options.link) {
                    good =
                        l.sourceId == options.link.sourceId
                    ||  l.duplicateId == options.link.sourceId;
                }

                if (options.findByMeta) {
                    var s = debugData.meta._sources[options.findByMeta];
                    good = s.pluginId == methodData.method.pluginId && s.method == methodData.method.name;
                }

                if (options.findByData) {
                    good = _.intersection(_.keys(l), options.findByData).length > 0;
                }

                if (good) {

                    var methodId = methodData.method.pluginId + " - " + methodData.method.name;

                    var exists = result.indexOf(methodId) > -1
                    if (exists) {
                        return
                    }

                    result.push(methodId);

                    var params = debugData.plugins[methodData.method.pluginId].methods[methodData.method.name];

                    // Find parent data source.

                    var findSourceForRequirements = _.difference(params, defaultContext);

                    if (findSourceForRequirements.length > 0) {
                        findUsedMethods({
                            maxLevel: levelIdx,
                            findByData: findSourceForRequirements
                        }, debugData, result);
                    }
                }
            });
        });
    });

    return result;
}