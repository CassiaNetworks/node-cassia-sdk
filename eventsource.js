const parse = require('url').parse;
const events = require('events');
const https = require('https');
const http = require('http');
const util = require('util');

const httpsOptions = [
    'pfx', 'key', 'passphrase', 'cert', 'ca', 'ciphers',
    'rejectUnauthorized', 'secureProtocol', 'servername', 'checkServerIdentity',
];

const original = function origin(url) {
    if ('string' === typeof url) {
        try {
            return new URL(url).origin;
        } catch (er) {
            return 'null';
        }
    } else {
        return url.origin;
    }
};

const bom = [239, 187, 191];
const colon = 58;
const space = 32;
const lineFeed = 10;
const carriageReturn = 13;

function hasBom(buf) {
    return bom.every(function(charCode, index) {
        return buf[index] === charCode;
    });
}

/**
 * Creates a new EventSource object
 *
 * @param {String} url the URL to which to connect
 * @param {Object} [eventSourceInitDict] extra init params. See README for details.
 * @api public
 **/
function EventSource(url, eventSourceInitDict) {
    let readyState = EventSource.CONNECTING;
    Object.defineProperty(this, 'readyState', {
        get: function() {
            return readyState;
        },
    });

    Object.defineProperty(this, 'url', {
        get: function() {
            return url;
        },
    });

    const self = this;
    self.reconnectInterval = 1000;
    self.connectionInProgress = false;

    function onConnectionClosed(message) {
        if (readyState === EventSource.CLOSED) return;
        readyState = EventSource.CONNECTING;
        _emit('error', new Event('error', {message: message}));

        // The url may have been changed by a temporary
        // redirect. If that's the case, revert it now.
        if (reconnectUrl) {
            url = reconnectUrl;
            reconnectUrl = null;
        }
        setTimeout(function() {
            if (readyState !== EventSource.CONNECTING || self.connectionInProgress) {
                return;
            }
            self.connectionInProgress = true;
            connect();
        }, self.reconnectInterval);
    }

    let req;
    let lastEventId = '';
    if (eventSourceInitDict && eventSourceInitDict.headers && eventSourceInitDict.headers['Last-Event-ID']) {
        lastEventId = eventSourceInitDict.headers['Last-Event-ID'];
        delete eventSourceInitDict.headers['Last-Event-ID'];
    }

    let discardTrailingNewline = false;
    let data = '';
    let eventName = '';

    let reconnectUrl = null;

    function connect() {
        const options = parse(url);
        let isSecure = options.protocol === 'https:';
        options.headers = {'Cache-Control': 'no-cache', 'Accept': 'text/event-stream'};
        if (lastEventId) options.headers['Last-Event-ID'] = lastEventId;
        if (eventSourceInitDict && eventSourceInitDict.headers) {
            for (const i in eventSourceInitDict.headers) {
                const header = eventSourceInitDict.headers[i];
                if (header) {
                    options.headers[i] = header;
                }
            }
        }

        // Legacy: this should be specified as `eventSourceInitDict.https.rejectUnauthorized`,
        // but for now exists as a backwards-compatibility layer
        options.rejectUnauthorized = !(eventSourceInitDict && !eventSourceInitDict.rejectUnauthorized);

        if (eventSourceInitDict && eventSourceInitDict.createConnection !== undefined) {
            options.createConnection = eventSourceInitDict.createConnection;
        }

        // If specify http proxy, make the request to sent to the proxy server,
        // and include the original url in path and Host headers
        const useProxy = eventSourceInitDict && eventSourceInitDict.proxy;
        if (useProxy) {
            const proxy = parse(eventSourceInitDict.proxy);
            isSecure = proxy.protocol === 'https:';

            options.protocol = isSecure ? 'https:' : 'http:';
            options.path = url;
            options.headers.Host = options.host;
            options.hostname = proxy.hostname;
            options.host = proxy.host;
            options.port = proxy.port;
        }

        // If https options are specified, merge them into the request options
        if (eventSourceInitDict && eventSourceInitDict.https) {
            for (const optName in eventSourceInitDict.https) {
                if (httpsOptions.indexOf(optName) === -1) {
                    continue;
                }

                const option = eventSourceInitDict.https[optName];
                if (option !== undefined) {
                    options[optName] = option;
                }
            }
        }

        // Pass this on to the XHR
        if (eventSourceInitDict && eventSourceInitDict.withCredentials !== undefined) {
            options.withCredentials = eventSourceInitDict.withCredentials;
        }

        req = (isSecure ? https : http).request(options, function(res) {
            self.connectionInProgress = false;
            // Handle HTTP errors
            if (res.statusCode === 500 || res.statusCode === 502 || res.statusCode === 503 || res.statusCode === 504) {
                _emit('error', new Event('error', {status: res.statusCode, message: res.statusMessage}));
                onConnectionClosed();
                return;
            }

            // Handle HTTP redirects
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
                if (!res.headers.location) {
                    // Server sent redirect response without Location header.
                    _emit('error', new Event('error', {status: res.statusCode, message: res.statusMessage}));
                    return;
                }
                if (res.statusCode === 307) reconnectUrl = url;
                url = res.headers.location;
                process.nextTick(connect);
                return;
            }

            if (res.statusCode !== 200) {
                _emit('error', new Event('error', {status: res.statusCode, message: res.statusMessage}));
                return self.close();
            }

            readyState = EventSource.OPEN;
            res.on('close', function() {
                res.removeAllListeners('close');
                res.removeAllListeners('end');
                onConnectionClosed();
            });

            res.on('end', function() {
                res.removeAllListeners('close');
                res.removeAllListeners('end');
                onConnectionClosed();
            });
            _emit('open', new Event('open'));

            // text/event-stream parser adapted from webkit's
            // Source/WebCore/page/EventSource.cpp
            let isFirst = true;
            let buf;
            let startingPos = 0;
            let startingFieldLength = -1;
            res.on('data', function(chunk) {
                buf = buf ? Buffer.concat([buf, chunk]) : chunk;
                if (isFirst && hasBom(buf)) {
                    buf = buf.slice(bom.length);
                }

                isFirst = false;
                let pos = 0;
                const length = buf.length;

                while (pos < length) {
                    if (discardTrailingNewline) {
                        if (buf[pos] === lineFeed) {
                            ++pos;
                        }
                        discardTrailingNewline = false;
                    }

                    let lineLength = -1;
                    let fieldLength = startingFieldLength;
                    let c;

                    for (let i = startingPos; lineLength < 0 && i < length; ++i) {
                        c = buf[i];
                        if (c === colon) {
                            if (fieldLength < 0) {
                                fieldLength = i - pos;
                            }
                        } else if (c === carriageReturn) {
                            discardTrailingNewline = true;
                            lineLength = i - pos;
                        } else if (c === lineFeed) {
                            lineLength = i - pos;
                        }
                    }

                    if (lineLength < 0) {
                        startingPos = length - pos;
                        startingFieldLength = fieldLength;
                        break;
                    } else {
                        startingPos = 0;
                        startingFieldLength = -1;
                    }

                    parseEventStreamLine(buf, pos, fieldLength, lineLength);

                    pos += lineLength + 1;
                }

                if (pos === length) {
                    buf = void 0;
                } else if (pos > 0) {
                    buf = buf.slice(pos);
                }
            });
        });

        req.on('error', function(err) {
            self.connectionInProgress = false;
            onConnectionClosed(err.message);
        });

        if (req.setNoDelay) req.setNoDelay(true);
        req.end();
    }

    connect();

    function _emit(...args) {
        if (self.listeners(args[0]).length > 0) {
            self.emit(...args);
        }
    }

    this._close = function() {
        if (readyState === EventSource.CLOSED) return;
        readyState = EventSource.CLOSED;
        if (req.abort) req.abort();
        if (req.xhr && req.xhr.abort) req.xhr.abort();
    };

    function parseEventStreamLine(buf, pos, fieldLength, lineLength) {
        if (lineLength === 0) {
            if (data.length > 0) {
                const type = eventName || 'message';
                _emit(type, new MessageEvent(type, {
                    data: data.slice(0, -1), // remove trailing newline
                    lastEventId: lastEventId,
                    origin: original(url),
                }));
                data = '';
            }
            eventName = void 0;
        } else if (fieldLength > 0) {
            const noValue = fieldLength < 0;
            let step = 0;
            const field = buf.slice(pos, pos + (noValue ? lineLength : fieldLength)).toString();

            if (noValue) {
                step = lineLength;
            } else if (buf[pos + fieldLength + 1] !== space) {
                step = fieldLength + 1;
            } else {
                step = fieldLength + 2;
            }
            pos += step;

            const valueLength = lineLength - step;
            const value = buf.slice(pos, pos + valueLength).toString();

            if (field === 'data') {
                data += value + '\n';
            } else if (field === 'event') {
                eventName = value;
            } else if (field === 'id') {
                lastEventId = value;
            } else if (field === 'retry') {
                const retry = parseInt(value, 10);
                if (!Number.isNaN(retry)) {
                    self.reconnectInterval = retry;
                }
            }
        }
    }
}

module.exports = EventSource;

util.inherits(EventSource, events.EventEmitter);
EventSource.prototype.constructor = EventSource; // make stacktraces readable

['open', 'error', 'message'].forEach(function(method) {
    Object.defineProperty(EventSource.prototype, 'on' + method, {
    /**
     * Returns the current listener
     *
     * @return {Mixed} the set function or undefined
     * @api private
     */
        get: function get() {
            const listener = this.listeners(method)[0];
            return listener ? (listener._listener ? listener._listener : listener) : undefined;
        },

        /**
     * Start listening for events
     *
     * @param {Function} listener the listener
     * @return {Mixed} the set function or undefined
     * @api private
     */
        set: function set(listener) {
            this.removeAllListeners(method);
            this.addEventListener(method, listener);
        },
    });
});

/**
 * Ready states
 */
Object.defineProperty(EventSource, 'CONNECTING', {enumerable: true, value: 0});
Object.defineProperty(EventSource, 'OPEN', {enumerable: true, value: 1});
Object.defineProperty(EventSource, 'CLOSED', {enumerable: true, value: 2});

EventSource.prototype.CONNECTING = 0;
EventSource.prototype.OPEN = 1;
EventSource.prototype.CLOSED = 2;

/**
 * Closes the connection, if one is made, and sets the readyState attribute to 2 (closed)
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/EventSource/close
 * @api public
 */
EventSource.prototype.close = function() {
    this._close();
};

/**
 * Emulates the W3C Browser based WebSocket interface using addEventListener.
 *
 * @param {String} type A string representing the event type to listen out for
 * @param {Function} listener callback
 * @see https://developer.mozilla.org/en/DOM/element.addEventListener
 * @see http://dev.w3.org/html5/websockets/#the-websocket-interface
 * @api public
 */
EventSource.prototype.addEventListener = function addEventListener(type, listener) {
    if (typeof listener === 'function') {
    // store a reference so we can return the original function again
        listener._listener = listener;
        this.on(type, listener);
    }
};

/**
 * Emulates the W3C Browser based WebSocket interface using dispatchEvent.
 *
 * @param {Event} event An event to be dispatched
 * @see https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/dispatchEvent
 * @api public
 */
EventSource.prototype.dispatchEvent = function dispatchEvent(event) {
    if (!event.type) {
        throw new Error('UNSPECIFIED_EVENT_TYPE_ERR');
    }
    // if event is instance of an CustomEvent (or has 'details' property),
    // send the detail object as the payload for the event
    this.emit(event.type, event.detail);
};

/**
 * Emulates the W3C Browser based WebSocket interface using removeEventListener.
 *
 * @param {String} type A string representing the event type to remove
 * @param {Function} listener callback
 * @see https://developer.mozilla.org/en/DOM/element.removeEventListener
 * @see http://dev.w3.org/html5/websockets/#the-websocket-interface
 * @api public
 */
EventSource.prototype.removeEventListener = function removeEventListener(type, listener) {
    if (typeof listener === 'function') {
        listener._listener = undefined;
        this.removeListener(type, listener);
    }
};

/**
 * W3C Event
 *
 * @see http://www.w3.org/TR/DOM-Level-3-Events/#interface-Event
 * @api private
 */
function Event(type, optionalProperties) {
    Object.defineProperty(this, 'type', {writable: false, value: type, enumerable: true});
    if (optionalProperties) {
        for (const f in optionalProperties) {
            if (optionalProperties.hasOwnProperty(f)) {
                Object.defineProperty(this, f, {writable: false, value: optionalProperties[f], enumerable: true});
            }
        }
    }
}

/**
 * W3C MessageEvent
 *
 * @see http://www.w3.org/TR/webmessaging/#event-definitions
 * @api private
 */
function MessageEvent(type, eventInitDict) {
    Object.defineProperty(this, 'type', {writable: false, value: type, enumerable: true});
    for (const f in eventInitDict) {
        if (eventInitDict.hasOwnProperty(f)) {
            Object.defineProperty(this, f, {writable: false, value: eventInitDict[f], enumerable: true});
        }
    }
}
