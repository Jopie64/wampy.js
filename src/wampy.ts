/**
 * Project: wampy.js
 *
 * https://github.com/KSDaemon/wampy.js
 *
 * A lightweight client-side implementation of
 * WAMP (The WebSocket Application Messaging Protocol v2)
 * http://wamp.ws
 *
 * Provides asynchronous RPC/PubSub over WebSocket.
 *
 * Copyright 2014 KSDaemon. Licensed under the MIT License.
 * See @license text at http://www.opensource.org/licenses/mit-license.php
 *
 */

import { WAMP_MSG_SPEC, WAMP_ERROR_MSG } from './constants';
import { getWebSocket } from './utils';
import { JsonSerializer } from './serializers/JsonSerializer';
import { IWampy, WampyOptions, Payload, PublishCallbacksHash, PublishAdvancedOptions, SubscribeCallbacksHash, Dict, RPCResult, ErrorArgs, Args, EventCallback, SubscribeAdvancedOptions, RegisterAdvancedOptions, RPCCallback, RegisterCallbacksHash, Callback, UnregisterCallbacksHash, UnsubscibeCallbacksHash, SuccessCallback, CallCallbacksHash, CallAdvancedOptions, CancelCallbacksHash, CancelAdvancedOptions } from './types';

interface OpStatus {
    code: number,
    description: string,
    reqId?: number
}

interface Cache {
    sessionId: number | null;
    reqId: number;
    server_wamp_features: {
        roles: {
            broker?: any;
            dealer?: any;
        };
    };
    isSayingGoodbye: boolean;
    opStatus: OpStatus;
    timer: number;
    reconnectingAttempts: number;
}

interface TopicType {
    topic: string,
    patternBased: boolean,
    allowWAMP: boolean
};

type Role = 'broker' | 'dealer';

type Message = [number, ...any[]];

type Registrations<T> = {[key: string]: T};

interface RpcRegistration {
    id: number;
    callbacks: any[];
}

interface TopicRegistration {
    id: number;
    callbacks: any[];
}

/**
 * Check if value is array
 * @param obj
 * @returns {boolean}
 * @private
 */
const _isArray = (obj: any): obj is any[] => (!!obj) && (Array.isArray(obj));

/**
 * Check if value is object literal
 * @param obj
 * @returns {boolean}
 * @private
 */
const _isPlainObject = (obj: any): obj is Object => {
    if (!_isObject(obj)) {
        return false;
    }

    // If has modified constructor
    const ctor = obj.constructor;
    if (typeof ctor !== 'function') {
        return false;
    }

    // If has modified prototype
    const prot = ctor.prototype;
    if (_isObject(prot) === false) {
        return false;
    }

    // If constructor does not have an Object-specific method
    if (prot.hasOwnProperty('isPrototypeOf') === false) {
        return false;
    }

    return true;
}

/**
 * Check if value is an object
 * @param obj
 * @returns {boolean}
 * @private
 */
const _isObject = (obj: any): obj is Object =>
    obj !== null
        && typeof obj === 'object'
        && Array.isArray(obj) === false
        && Object.prototype.toString.call(obj) === '[object Object]';


const makeEmptyCache = () => ({
    /**
     * WAMP Session ID
     * @type {string}
     */
    sessionId: null,

    /**
     * WAMP Session scope requests ID
     * @type {int}
     */
    reqId: 0,

    /**
     * Server WAMP roles and features
     */
    server_wamp_features: { roles: {} },

    /**
     * Are we in state of saying goodbye
     * @type {boolean}
     */
    isSayingGoodbye: false,

    /**
     * Status of last operation
     */
    opStatus: { code: 0, description: 'Success!', reqId: 0 },

    /**
     * Timer for reconnection
     * @type {null}
     */
    timer: 0,

    /**
     * Reconnection attempts
     * @type {number}
     */
    reconnectingAttempts: 0
});

/**
 * WAMP Client Class
 */
class Wampy implements IWampy {

    /**
     * Wampy version
     * @type {string}
     * @private
     */
    version = 'v7.0.0';

    /**
     * WS Url
     * @type {string}
     * @private
     */
    _url: string | undefined;

    /**
     * WS protocols
     * @type {Array}
     * @private
     */
    _protocols = ['wamp.2.json'];

    /**
     * WAMP features, supported by Wampy
     * @type {object}
     * @private
     */
    _wamp_features = {
        agent: 'Wampy.js ' + this.version,
        roles: {
            publisher : {
                features: {
                    subscriber_blackwhite_listing: true,
                    publisher_exclusion          : true,
                    publisher_identification     : true
                }
            },
            subscriber: {
                features: {
                    pattern_based_subscription: true,
                    publication_trustlevels   : true
                }
            },
            caller    : {
                features: {
                    caller_identification   : true,
                    progressive_call_results: true,
                    call_canceling          : true,
                    call_timeout            : true
                }
            },
            callee    : {
                features: {
                    caller_identification     : true,
                    call_trustlevels          : true,
                    pattern_based_registration: true,
                    shared_registration       : true
                }
            }
        }
    };

    /**
     * Internal cache for object lifetime
     * @type {Object}
     * @private
     */
    _cache: Cache = makeEmptyCache();

    /**
     * WebSocket object
     * @type {Object}
     * @private
     */
    _ws: WebSocket | null = null;

    /**
     * Internal queue for websocket requests, for case of disconnect
     * @type {Array}
     * @private
     */
    _wsQueue: any[] = [];

    /**
     * Internal queue for wamp requests
     * @type {object}
     * @private
     */
    _requests: Registrations<any> = {};

    /**
     * Stored RPC
     * @type {object}
     * @private
     */
    _calls: Registrations<any> = {};

    /**
     * Stored Pub/Sub
     * @type {object}
     * @private
     */
    _subscriptions: Registrations<any> = {};

    /**
     * Stored Pub/Sub topics
     * @type {Array}
     * @private
     */
    _subsTopics = new Set<string>();

    /**
     * Stored RPC Registrations
     * @type {object}
     * @private
     */
    _rpcRegs: Registrations<RpcRegistration> = {};

    /**
     * Stored RPC names
     * @type {Array}
     * @private
     */
    _rpcNames = new Set<string>();

    /**
     * Options hash-table
     * @type {Object}
     * @private
     */
    _options: WampyOptions = {
        /**
         * Logging
         * @type {boolean}
         */
        debug: false,

        /**
         * Reconnecting flag
         * @type {boolean}
         */
        autoReconnect: true,

        /**
         * Reconnecting interval (in ms)
         * @type {number}
         */
        reconnectInterval: 2 * 1000,

        /**
         * Maximum reconnection retries
         * @type {number}
         */
        maxRetries: 25,

        /**
         * WAMP Realm to join
         * @type {string}
         */
        realm: '',

        /**
         * Custom attributes to send to router on hello
         * @type {object}
         */
        helloCustomDetails: null,

        /**
         * Validation of the topic URI structure
         * @type {string} - strict or loose
         */
        uriValidation: 'strict',

        /**
         * Authentication id to use in challenge
         * @type {string}
         */
        authid: undefined,

        /**
         * Supported authentication methods
         * @type {array}
         */
        authmethods: [],

        /**
         * onChallenge callback
         * @type {function}
         */
        onChallenge: undefined,

        /**
         * onConnect callback
         * @type {function}
         */
        onConnect: undefined,

        /**
         * onClose callback
         * @type {function}
         */
        onClose: undefined,

        /**
         * onError callback
         * @type {function}
         */
        onError: undefined,

        /**
         * onReconnect callback
         * @type {function}
         */
        onReconnect: undefined,

        /**
         * onReconnectSuccess callback
         * @type {function}
         */
        onReconnectSuccess: undefined,

        /**
         * User provided WebSocket class
         * @type {function}
         */
        ws: undefined,

        /**
         * User provided additional HTTP headers (for use in Node.js enviroment)
         * @type {object}
         */
        additionalHeaders: undefined,

        /**
         * User provided WS Client Config Options (for use in Node.js enviroment)
         * @type {object}
         */
        wsRequestOptions: null,

        /**
         * User provided msgpack class
         * @type {object}
         */
        serializer: new JsonSerializer()
    };

    /**
     * Wampy constructor
     */
    constructor (urlOrOptions?: string | WampyOptions, options?: WampyOptions) {

        if (typeof urlOrOptions === 'string') {
            this._url = urlOrOptions;
        }

        if (_isPlainObject(options)) {
            this._options = {...this._options, ...options };
        } else if (_isPlainObject(urlOrOptions)) {
            this._options = {...this._options, ...(urlOrOptions as WampyOptions)};
        }

        if (this._url) {
            this.connect(this._url);
        }
    }

    /* Internal utils methods */
    /**
     * Internal logger
     * @private
     */
    _log (...args: any) {
        if (this._options.debug) {
            console.log(args);
        }
    }

    /**
     * Get the new unique request id
     * @returns {number}
     * @private
     */
    _getReqId () {
        return ++this._cache.reqId;
    }

    /**
     * Fix websocket protocols based on options
     * @private
     */
    _setWsProtocols () {
        if (!(this._options.serializer instanceof JsonSerializer)) {
            this._protocols.unshift('wamp.2.' + this._options.serializer.protocol);
        }
    }

    /**
     * Prerequisite checks for any wampy api call
     * @param {object} topicType { topic: URI, patternBased: true|false, allowWAMP: true|false }
     * @param {string} role
     * @param {object} callbacks
     * @returns {boolean}
     * @private
     */
    _preReqChecks (
        topicType: TopicType | null, role: Role,
        callbacks?: SubscribeCallbacksHash | EventCallback | Callback | UnregisterCallbacksHash | SuccessCallback | CallCallbacksHash
    ) {
        let flag = true;

        if (this._cache.sessionId && !this._cache.server_wamp_features.roles[role]) {
            this._cache.opStatus = role === 'broker'
                ? WAMP_ERROR_MSG['NO_BROKER']
                : WAMP_ERROR_MSG['NO_DEALER'];
            flag = false;
        }

        if (topicType && !this._validateURI(topicType.topic, topicType.patternBased, topicType.allowWAMP)) {
            this._cache.opStatus = WAMP_ERROR_MSG.URI_ERROR;
            flag = false;
        }

        if (flag) {
            return true;
        }

        if (_isPlainObject(callbacks) && typeof callbacks === 'object' && callbacks.onError) {
            callbacks.onError({ error: this._cache.opStatus.description });
        }

        return false;
    }

    /**
     * Validate uri
     * @param {string} uri
     * @param {boolean} patternBased
     * @param {boolean} allowWAMP
     * @returns {boolean}
     * @private
     */
    _validateURI (uri: string, patternBased: boolean, allowWAMP: boolean) {
        let reBase;
        let rePattern;

        if (this._options.uriValidation === 'strict') {
            reBase = /^([0-9a-zA-Z_]+\.)*([0-9a-zA-Z_]+)$/;
            rePattern = /^([0-9a-zA-Z_]+\.{1,2})*([0-9a-zA-Z_]+)$/;
        } else if (this._options.uriValidation === 'loose') {
            reBase = /^([^\s.#]+\.)*([^\s.#]+)$/;
            rePattern = /^([^\s.#]+\.{1,2})*([^\s.#]+)$/;
        } else {
            return false;
        }
        const re = patternBased ? rePattern : reBase;

        if (allowWAMP) {
            return re.test(uri);
        } else {
            return !(!re.test(uri) || uri.indexOf('wamp.') === 0);
        }
    }

    /**
     * Encode WAMP message
     * @param {Array} msg
     * @returns {*}
     * @private
     */
    _encode (msg: Message) {
        try {
            return this._options.serializer.encode(msg);
        } catch (e) {
            this._hardClose('wamp.error.protocol_violation', 'Can not encode message');
        }
    }

    /**
     * Decode WAMP message
     * @param  msg
     * @returns {Promise}
     * @private
     */
    _decode (msg: any): Promise<Message> {
        return this._options.serializer.decode(msg);
    }

    /**
     * Hard close of connection due to protocol violations
     * @param {string} errorUri
     * @param {string} message
     * @private
     */
    _hardClose (errorUri: string, message: string) {
        this._log('[wampy] ' + message);
        // Cleanup outgoing message queue
        this._wsQueue = [];
        this._send([WAMP_MSG_SPEC.ABORT, { message }, errorUri]);

        if (this._options.onError) {
            this._options.onError({ error: errorUri, details: { message } });
        }
        if (this._ws) { this._ws.close(); }
    }

    /**
     * Send encoded message to server
     * @param {Array} msg
     * @private
     */
    _send (msg?: Message) {
        if (msg) {
            this._wsQueue.push(this._encode(msg));
        }

        if (this._ws && this._ws.readyState === 1 && this._cache.sessionId) {
            while (this._wsQueue.length) {
                this._ws.send(this._wsQueue.shift());
            }
        }
    }

    /**
     * Reset internal state and cache
     * @private
     */
    _resetState () {
        this._wsQueue = [];
        this._subscriptions = {};
        this._subsTopics = new Set();
        this._requests = {};
        this._calls = {};
        this._rpcRegs = {};
        this._rpcNames = new Set();

        // Just keep attrs that are have to be present
        this._cache = makeEmptyCache();
    }

    /**
     * Initialize internal websocket callbacks
     * @private
     */
    _initWsCallbacks () {
        if (this._ws) {
            this._ws.onopen = () => {
                this._wsOnOpen();
            };
            this._ws.onclose = event => {
                this._wsOnClose(event);
            };
            this._ws.onmessage = event => {
                this._wsOnMessage(event);
            };
            this._ws.onerror = error => {
                this._wsOnError(error);
            };
        }
    }

    /**
     * Internal websocket on open callback
     * @private
     */
    _wsOnOpen () {
        const options = {...this._options.helloCustomDetails, ...this._wamp_features};
        if (!this._ws) {
            return;
        }
        const serverProtocol = this._ws.protocol ? this._ws.protocol.split('.')[2] : '';

        if (this._options.authid) {
            options.authmethods = this._options.authmethods;
            options.authid = this._options.authid;
        }

        this._log('[wampy] websocket connected');

        if (this._options.serializer.protocol !== serverProtocol) {
            // Server have chosen not our preferred protocol

            // Falling back to json if possible
            //FIXME Temp hack for React Native Environment.
            // Due to bug (facebook/react-native#24796), it doesn't provide selected subprotocol.
            // Remove when ^^^ bug will be fixed.
            if (serverProtocol === 'json' ||
                (typeof navigator != 'undefined' &&
                    navigator.product === 'ReactNative' &&
                    typeof this._ws.protocol === 'undefined')) {
                this._options.serializer = new JsonSerializer();
            } else {
                this._cache.opStatus = WAMP_ERROR_MSG.NO_SERIALIZER_AVAILABLE;
                return this;
            }

        }

        if (this._options.serializer.isBinary) {
            this._ws.binaryType = 'arraybuffer';
        }

        // WAMP SPEC: [HELLO, Realm|uri, Details|dict]
        // Sending directly 'cause it's a hello msg and no sessionId check is needed
        this._ws.send(this._encode([WAMP_MSG_SPEC.HELLO, this._options.realm, options]));
    }

    /**
     * Internal websocket on close callback
     * @param {object} event
     * @private
     */
    _wsOnClose (event: CloseEvent) {
        this._log('[wampy] websocket disconnected. Info: ', event);

        // Automatic reconnection
        if ((this._cache.sessionId || this._cache.reconnectingAttempts) &&
            this._options.autoReconnect && this._options.maxRetries &&
            this._cache.reconnectingAttempts < this._options.maxRetries && !this._cache.isSayingGoodbye
        ) {
            this._cache.sessionId = null;
            this._cache.timer = setTimeout(() => {
                this._wsReconnect();
            }, this._options.reconnectInterval);
        } else {
            // No reconnection needed or reached max retries count
            if (this._options.onClose) {
                this._options.onClose();
            }

            this._resetState();
            this._ws = null;
        }
    }

    /**
     * Internal websocket on event callback
     * @param {object} event
     * @private
     */
    _wsOnMessage (event: MessageEvent) {
        this._decode(event.data).then(data => {

            this._log('[wampy] websocket message received: ', data);

            let id, i, self = this;

            switch (data[0]) {
                case WAMP_MSG_SPEC.WELCOME:
                    // WAMP SPEC: [WELCOME, Session|id, Details|dict]
                    if (this._cache.sessionId) {
                        this._hardClose('wamp.error.protocol_violation',
                            'Received WELCOME message after session was established');
                    } else {
                        this._cache.sessionId = data[1];
                        this._cache.server_wamp_features = data[2];

                        if (this._cache.reconnectingAttempts) {
                            // There was reconnection

                            this._cache.reconnectingAttempts = 0;

                            if (this._options.onReconnectSuccess) {
                                this._options.onReconnectSuccess(data[2]);
                            }

                            // Let's renew all previous state
                            this._renewSubscriptions();
                            this._renewRegistrations();

                        } else {
                            // Firing onConnect event on real connection to WAMP server
                            if (this._options.onConnect) {
                                this._options.onConnect(data[2]);
                            }
                        }

                        // Send local queue if there is something out there
                        this._send();
                    }
                    break;
                case WAMP_MSG_SPEC.ABORT:
                    // WAMP SPEC: [ABORT, Details|dict, Reason|uri]
                    if (this._options.onError) {
                        this._options.onError({ error: data[2], details: data[1] });
                    }
                    if (this._ws) {
                        this._ws.close();
                    }
                    break;
                case WAMP_MSG_SPEC.CHALLENGE:
                    // WAMP SPEC: [CHALLENGE, AuthMethod|string, Extra|dict]
                    if (this._cache.sessionId) {
                        this._hardClose('wamp.error.protocol_violation',
                            'Received CHALLENGE message after session was established');
                    } else if (this._ws) {
                        const ws = this._ws; // Make sure it isn't null on then()
                        if (this._options.authid && typeof this._options.onChallenge === 'function') {

                            const p = Promise.resolve(this._options.onChallenge(data[1], data[2]));

                            p.then((key) => {

                                // Sending directly 'cause it's a challenge msg and no sessionId check is needed
                                ws.send(this._encode([WAMP_MSG_SPEC.AUTHENTICATE, key, {}]));

                            }).catch(e => {
                                ws.send(this._encode([
                                    WAMP_MSG_SPEC.ABORT,
                                    { message: 'Exception in onChallenge handler raised!' },
                                    'wamp.error.cannot_authenticate'
                                ]));
                                if (this._options.onError) {
                                    this._options.onError({ error: WAMP_ERROR_MSG.CRA_EXCEPTION.description });
                                }
                                ws.close();
                                this._cache.opStatus = WAMP_ERROR_MSG.CRA_EXCEPTION;
                            });

                        } else {

                            ws.send(this._encode([
                                WAMP_MSG_SPEC.ABORT,
                                { message: WAMP_ERROR_MSG.NO_CRA_CB_OR_ID.description },
                                'wamp.error.cannot_authenticate'
                            ]));
                            if (this._options.onError) {
                                this._options.onError({ error: WAMP_ERROR_MSG.NO_CRA_CB_OR_ID.description });
                            }
                            ws.close();
                            this._cache.opStatus = WAMP_ERROR_MSG.NO_CRA_CB_OR_ID;

                        }
                    }
                    break;
                case WAMP_MSG_SPEC.GOODBYE:
                    // WAMP SPEC: [GOODBYE, Details|dict, Reason|uri]
                    if (!this._cache.sessionId) {
                        this._hardClose('wamp.error.protocol_violation',
                            'Received GOODBYE message before session was established');
                    } else {
                        if (!this._cache.isSayingGoodbye) {    // get goodbye, initiated by server
                            this._cache.isSayingGoodbye = true;
                            this._send([WAMP_MSG_SPEC.GOODBYE, {}, 'wamp.close.goodbye_and_out']);
                        }
                        this._cache.sessionId = null;
                        if (this._ws) {
                            this._ws.close();
                        }
                    }
                    break;
                case WAMP_MSG_SPEC.ERROR:
                    // WAMP SPEC: [ERROR, REQUEST.Type|int, REQUEST.Request|id, Details|dict,
                    //             Error|uri, (Arguments|list, ArgumentsKw|dict)]
                    if (!this._cache.sessionId) {
                        this._hardClose('wamp.error.protocol_violation',
                            'Received ERROR message before session was established');
                    } else {
                        switch (data[1]) {
                            case WAMP_MSG_SPEC.SUBSCRIBE:
                            case WAMP_MSG_SPEC.UNSUBSCRIBE:
                            case WAMP_MSG_SPEC.PUBLISH:
                            case WAMP_MSG_SPEC.REGISTER:
                            case WAMP_MSG_SPEC.UNREGISTER:

                                this._requests[data[2]] && this._requests[data[2]].callbacks.onError &&
                                this._requests[data[2]].callbacks.onError({
                                    error   : data[4],
                                    details : data[3],
                                    argsList: data[5],
                                    argsDict: data[6]
                                });
                                delete this._requests[data[2]];

                                break;
                            // case WAMP_MSG_SPEC.INVOCATION:
                            //     break;
                            case WAMP_MSG_SPEC.CALL:

                                // WAMP SPEC: [ERROR, CALL, CALL.Request|id, Details|dict,
                                //             Error|uri, Arguments|list, ArgumentsKw|dict]
                                this._calls[data[2]] && this._calls[data[2]].onError &&
                                this._calls[data[2]].onError({
                                    error   : data[4],
                                    details : data[3],
                                    argsList: data[5],
                                    argsDict: data[6]
                                });
                                delete this._calls[data[2]];

                                break;
                            default:
                                this._hardClose('wamp.error.protocol_violation', 'Received invalid ERROR message');
                                break;
                        }
                    }
                    break;
                case WAMP_MSG_SPEC.SUBSCRIBED:
                    // WAMP SPEC: [SUBSCRIBED, SUBSCRIBE.Request|id, Subscription|id]
                    if (!this._cache.sessionId) {
                        this._hardClose('wamp.error.protocol_violation',
                            'Received SUBSCRIBED message before session was established');
                    } else {
                        if (this._requests[data[1]]) {
                            this._subscriptions[this._requests[data[1]].topic] = this._subscriptions[data[2]] = {
                                id             : data[2],
                                callbacks      : [this._requests[data[1]].callbacks.onEvent],
                                advancedOptions: this._requests[data[1]].advancedOptions
                            };

                            this._subsTopics.add(this._requests[data[1]].topic);

                            if (this._requests[data[1]].callbacks.onSuccess) {
                                this._requests[data[1]].callbacks.onSuccess();
                            }

                            delete this._requests[data[1]];

                        }
                    }
                    break;
                case WAMP_MSG_SPEC.UNSUBSCRIBED:
                    // WAMP SPEC: [UNSUBSCRIBED, UNSUBSCRIBE.Request|id]
                    if (!this._cache.sessionId) {
                        this._hardClose('wamp.error.protocol_violation',
                            'Received UNSUBSCRIBED message before session was established');
                    } else {
                        if (this._requests[data[1]]) {
                            id = this._subscriptions[this._requests[data[1]].topic].id;
                            delete this._subscriptions[this._requests[data[1]].topic];
                            delete this._subscriptions[id];

                            if (this._subsTopics.has(this._requests[data[1]].topic)) {
                                this._subsTopics.delete(this._requests[data[1]].topic);
                            }

                            if (this._requests[data[1]].callbacks.onSuccess) {
                                this._requests[data[1]].callbacks.onSuccess();
                            }

                            delete this._requests[data[1]];
                        }
                    }
                    break;
                case WAMP_MSG_SPEC.PUBLISHED:
                    // WAMP SPEC: [PUBLISHED, PUBLISH.Request|id, Publication|id]
                    if (!this._cache.sessionId) {
                        this._hardClose('wamp.error.protocol_violation',
                            'Received PUBLISHED message before session was established');
                    } else {
                        if (this._requests[data[1]]) {
                            if (this._requests[data[1]].callbacks && this._requests[data[1]].callbacks.onSuccess) {
                                this._requests[data[1]].callbacks.onSuccess();
                            }

                            delete this._requests[data[1]];
                        }
                    }
                    break;
                case WAMP_MSG_SPEC.EVENT:
                    if (!this._cache.sessionId) {
                        this._hardClose('wamp.error.protocol_violation',
                            'Received EVENT message before session was established');
                    } else {
                        if (this._subscriptions[data[1]]) {

                            // WAMP SPEC: [EVENT, SUBSCRIBED.Subscription|id, PUBLISHED.Publication|id,
                            //             Details|dict, PUBLISH.Arguments|list, PUBLISH.ArgumentKw|dict]

                            i = this._subscriptions[data[1]].callbacks.length;
                            while (i--) {
                                this._subscriptions[data[1]].callbacks[i]({
                                    details : data[3],
                                    argsList: data[4],
                                    argsDict: data[5]
                                });
                            }
                        }
                    }
                    break;
                case WAMP_MSG_SPEC.RESULT:
                    if (!this._cache.sessionId) {
                        this._hardClose('wamp.error.protocol_violation',
                            'Received RESULT message before session was established');
                    } else {
                        if (this._calls[data[1]]) {

                            // WAMP SPEC: [RESULT, CALL.Request|id, Details|dict,
                            //             YIELD.Arguments|list, YIELD.ArgumentsKw|dict]

                            this._calls[data[1]].onSuccess({
                                details : data[2],
                                argsList: data[3],
                                argsDict: data[4]
                            });
                            if (!(data[2].progress && data[2].progress === true)) {
                                // We receive final result (progressive or not)
                                delete this._calls[data[1]];
                            }
                        }
                    }
                    break;
                // case WAMP_MSG_SPEC.REGISTER:
                //     // WAMP SPEC:
                //     break;
                case WAMP_MSG_SPEC.REGISTERED:
                    // WAMP SPEC: [REGISTERED, REGISTER.Request|id, Registration|id]
                    if (!this._cache.sessionId) {
                        this._hardClose('wamp.error.protocol_violation',
                            'Received REGISTERED message before session was established');
                    } else {
                        if (this._requests[data[1]]) {
                            this._rpcRegs[this._requests[data[1]].topic] = this._rpcRegs[data[2]] = {
                                id       : data[2],
                                callbacks: [this._requests[data[1]].callbacks.rpc]
                            };

                            this._rpcNames.add(this._requests[data[1]].topic);

                            if (this._requests[data[1]].callbacks && this._requests[data[1]].callbacks.onSuccess) {
                                this._requests[data[1]].callbacks.onSuccess();
                            }

                            delete this._requests[data[1]];
                        }
                    }
                    break;
                // case WAMP_MSG_SPEC.UNREGISTER:
                //     // WAMP SPEC:
                //     break;
                case WAMP_MSG_SPEC.UNREGISTERED:
                    // WAMP SPEC: [UNREGISTERED, UNREGISTER.Request|id]
                    if (!this._cache.sessionId) {
                        this._hardClose('wamp.error.protocol_violation',
                            'Received UNREGISTERED message before session was established');
                    } else {
                        if (this._requests[data[1]]) {
                            id = this._rpcRegs[this._requests[data[1]].topic].id;
                            delete this._rpcRegs[this._requests[data[1]].topic];
                            delete this._rpcRegs[id];

                            if (this._rpcNames.has(this._requests[data[1]].topic)) {
                                this._rpcNames.delete(this._requests[data[1]].topic);
                            }

                            if (this._requests[data[1]].callbacks && this._requests[data[1]].callbacks.onSuccess) {
                                this._requests[data[1]].callbacks.onSuccess();
                            }

                            delete this._requests[data[1]];
                        }
                    }
                    break;
                case WAMP_MSG_SPEC.INVOCATION:
                    if (!this._cache.sessionId) {
                        this._hardClose('wamp.error.protocol_violation',
                            'Received INVOCATION message before session was established');
                    } else {
                        if (this._rpcRegs[data[2]]) {

                            // WAMP SPEC: [INVOCATION, Request|id, REGISTERED.Registration|id,
                            //             Details|dict, CALL.Arguments|list, CALL.ArgumentsKw|dict]

                            const invoke_result_handler = (results: RPCResult) => {
                                    // WAMP SPEC: [YIELD, INVOCATION.Request|id, Options|dict, (Arguments|list,
                                    // ArgumentsKw|dict)]
                                    const msg: Message = [WAMP_MSG_SPEC.YIELD, data[1], {}];

                                    if (_isPlainObject(results)) {

                                        if (_isPlainObject(results.options)) {
                                            msg[2] = results.options;
                                        }

                                        if (_isArray(results.argsList)) {
                                            msg.push(results.argsList);
                                        } else if (typeof (results.argsList) !== 'undefined') {
                                            msg.push([results.argsList]);
                                        }

                                        if (_isPlainObject(results.argsDict)) {
                                            if (msg.length === 3) {
                                                msg.push([]);
                                            }
                                            msg.push(results.argsDict);
                                        }
                                    }
                                    self._send(msg);
                                };
                            const invoke_error_handler = ({ details, error, argsList, argsDict }: Args & ErrorArgs) => {
                                    const msg: Message = [WAMP_MSG_SPEC.ERROR, WAMP_MSG_SPEC.INVOCATION,
                                        data[1], details || {}, error || 'wamp.error.invocation_exception'];

                                    if (argsList && _isArray(argsList)) {
                                        msg.push(argsList);
                                    }

                                    if (argsDict && _isPlainObject(argsDict)) {
                                        if (msg.length === 5) {
                                            msg.push([]);
                                        }
                                        msg.push(argsDict);
                                    }
                                    self._send(msg);
                                };

                            const p = Promise.resolve(this._rpcRegs[data[2]].callbacks[0]({
                                    details       : data[3],
                                    argsList      : data[4],
                                    argsDict      : data[5],
                                    result_handler: invoke_result_handler,
                                    error_handler : invoke_error_handler
                                }));

                            p.then((results) => {
                                invoke_result_handler(results);
                            }).catch(e => {
                                invoke_error_handler(e);
                            });

                        } else {
                            // WAMP SPEC: [ERROR, INVOCATION, INVOCATION.Request|id, Details|dict, Error|uri]
                            this._send([WAMP_MSG_SPEC.ERROR, WAMP_MSG_SPEC.INVOCATION,
                                data[1], {}, 'wamp.error.no_such_procedure']);
                            this._cache.opStatus = WAMP_ERROR_MSG.NON_EXIST_RPC_INVOCATION;
                        }
                    }
                    break;
                // case WAMP_MSG_SPEC.INTERRUPT:
                //     // WAMP SPEC:
                //     break;
                // case WAMP_MSG_SPEC.YIELD:
                //     // WAMP SPEC:
                //     break;
                default:
                    this._hardClose('wamp.error.protocol_violation', 'Received non-compliant WAMP message');
                    break;
            }
        }, err => {
            this._hardClose('wamp.error.protocol_violation', 'Can not decode received message');
        });
    }

    /**
     * Internal websocket on error callback
     * @param {object} error
     * @private
     */
    _wsOnError (error: Event) {
        this._log('[wampy] websocket error');

        if (this._options.onError) {
            this._options.onError({ error: 'Websocket error', event: error });
        }
    }

    /**
     * Reconnect to server in case of websocket error
     * @private
     */
    _wsReconnect () {
        if (!this._url) {
            return;
        }
        this._log('[wampy] websocket reconnecting...');

        if (this._options.onReconnect) {
            this._options.onReconnect();
        }

        this._cache.reconnectingAttempts++;
        this._ws = getWebSocket(this._url, this._protocols, this._options.ws,
            this._options.additionalHeaders || {}, this._options.wsRequestOptions);
        this._initWsCallbacks();
    }

    /**
     * Resubscribe to topics in case of communication error
     * @private
     */
    _renewSubscriptions () {
        let i;
        const subs = this._subscriptions,
            st = this._subsTopics;

        this._subscriptions = {};
        this._subsTopics = new Set();

        for (let topic of st) {
            i = subs[topic].callbacks.length;
            while (i--) {
                this.subscribe(topic, subs[topic].callbacks[i], subs[topic].advancedOptions);
            }
        }
    }

    /**
     * Reregister RPCs in case of communication error
     * @private
     */
    _renewRegistrations () {
        const rpcs = this._rpcRegs,
            rn = this._rpcNames;

        this._rpcRegs = {};
        this._rpcNames = new Set();

        for (let rpcName of rn) {
            this.register(rpcName, { rpc: rpcs[rpcName].callbacks[0] });
        }
    }

    /* Wampy public API */

    /**
     * Get or set Wampy options
     *
     * To get options - call without parameters
     * To set options - pass hash-table with options values
     *
     * @param {object} [opts]
     * @returns {*}
     */
    options (opts?: WampyOptions) {
        if (typeof (opts) === 'undefined') {
            return this._options || this;
        } else if (_isPlainObject(opts)) {
            this._options = { ...this._options, ...opts };
            return this;
        }
        return this;
    }

    /**
     * Get the status of last operation
     *
     * @returns {object} with 2 fields: code, description
     *      code: 0 - if operation was successful
     *      code > 0 - if error occurred
     *      description contains details about error
     *      reqId: last send request ID
     */
    getOpStatus () {
        return this._cache.opStatus;
    }

    /**
     * Get the WAMP Session ID
     *
     * @returns {string} Session ID
     */
    getSessionId () {
        return this._cache.sessionId || 0;
    }

    /**
     * Connect to server
     * @param {string} [url] New url (optional)
     * @returns {IWampy}
     */
    connect (url: string): IWampy {
        if (url) {
            this._url = url;
        }

        if (!this._url) {
            throw new Error('URL not defined');
        }

        if (this._options.realm) {

            const authp = (this._options.authid ? 1 : 0) +
                ((_isArray(this._options.authmethods) && this._options.authmethods.length) ? 1 : 0) +
                (typeof this._options.onChallenge === 'function' ? 1 : 0);

            if (authp > 0 && authp < 3) {
                this._cache.opStatus = WAMP_ERROR_MSG.NO_CRA_CB_OR_ID;
                return this;
            }

            this._setWsProtocols();
            this._ws = getWebSocket(this._url, this._protocols, this._options.ws,
                this._options.additionalHeaders || {}, this._options.wsRequestOptions);
            if (!this._ws) {
                this._cache.opStatus = WAMP_ERROR_MSG.NO_WS_OR_URL;
                return this;
            }
            this._initWsCallbacks();

        } else {
            this._cache.opStatus = WAMP_ERROR_MSG.NO_REALM;
        }

        return this;
    }

    /**
     * Disconnect from server
     * @returns {IWampy}
     */
    disconnect () {
        if (this._cache.sessionId) {
            // need to send goodbye message to server
            this._cache.isSayingGoodbye = true;
            this._send([WAMP_MSG_SPEC.GOODBYE, {}, 'wamp.close.system_shutdown']);
        } else if (this._ws) {
            this._ws.close();
        }

        this._cache.opStatus = WAMP_ERROR_MSG.SUCCESS;

        return this;
    }

    /**
     * Abort WAMP session establishment
     *
     * @returns {IWampy}
     */
    abort () {
        if (!this._ws) {
            return this;
        }

        if (!this._cache.sessionId && this._ws.readyState === 1) {
            this._send([WAMP_MSG_SPEC.ABORT, {}, 'wamp.error.abort']);
            this._cache.sessionId = null;
        }

        this._ws.close();
        this._cache.opStatus = WAMP_ERROR_MSG.SUCCESS;

        return this;
    }

    /**
     * Subscribe to a topic on a broker
     *
     * @param {string} topicURI
     * @param {function|object} callbacks - if it is a function - it will be treated as published event callback
     *                          or it can be hash table of callbacks:
     *                          { onSuccess: will be called when subscribe would be confirmed
     *                            onError: will be called if subscribe would be aborted
     *                            onEvent: will be called on receiving published event }
     * @param {object} advancedOptions - optional parameter. Must include any or all of the options:
     *                          { match: string matching policy ("prefix"|"wildcard") }
     *
     * @returns {IWampy}
     */
    subscribe (
        topicURI: string,
        callbacks: EventCallback | SubscribeCallbacksHash,
        advancedOptions?: SubscribeAdvancedOptions
    ) {
        let reqId, patternBased = false;
        const options: SubscribeAdvancedOptions = {};

        if ((typeof (advancedOptions) !== 'undefined') &&
            (_isPlainObject(advancedOptions)) &&
            advancedOptions.match) {

            if (/prefix|wildcard/.test(advancedOptions.match)) {
                options.match = advancedOptions.match;
                patternBased = true;
            }
        }

        if (!this._preReqChecks({ topic: topicURI, patternBased, allowWAMP: true },
            'broker',
            callbacks)) {
            return this;
        }

        if (typeof callbacks === 'function') {
            callbacks = { onEvent: callbacks };
        } else if (!_isPlainObject(callbacks) || typeof (callbacks.onEvent) === 'undefined') {
            this._cache.opStatus = WAMP_ERROR_MSG.NO_CALLBACK_SPEC;

            if (_isPlainObject(callbacks) && callbacks.onError) {
                callbacks.onError({ error: this._cache.opStatus.description });
            }

            return this;
        }

        if (!this._subscriptions[topicURI] || !this._subscriptions[topicURI].callbacks.length) {
            // no such subscription or processing unsubscribing

            reqId = this._getReqId();

            this._requests[reqId] = {
                topic: topicURI,
                callbacks,
                advancedOptions
            };

            // WAMP SPEC: [SUBSCRIBE, Request|id, Options|dict, Topic|uri]
            this._send([WAMP_MSG_SPEC.SUBSCRIBE, reqId, options, topicURI]);

        } else {    // already have subscription to this topic
            // There is no such callback yet
            if (this._subscriptions[topicURI].callbacks.indexOf(callbacks.onEvent) < 0) {
                this._subscriptions[topicURI].callbacks.push(callbacks.onEvent);
            }

            if (callbacks.onSuccess) {
                callbacks.onSuccess();
            }
        }

        this._cache.opStatus = WAMP_ERROR_MSG.SUCCESS;
        this._cache.opStatus.reqId = reqId;
        return this;
    }

    /**
     * Unsubscribe from topic
     * @param {string} topicURI
     * @param {function|object} callbacks - if it is a function - it will be treated as
     *                          published event callback to remove or it can be hash table of callbacks:
     *                          { onSuccess: will be called when unsubscribe would be confirmed
     *                            onError: will be called if unsubscribe would be aborted
     *                            onEvent: published event callback to remove }
     * @returns {IWampy}
     */
    unsubscribe (topicURI: string,
                 callbacks?: EventCallback | UnsubscibeCallbacksHash
    ) {
        let reqId, i = -1;

        if (!this._preReqChecks(null, 'broker', callbacks)) {
            return this;
        }

        if (this._subscriptions[topicURI]) {

            reqId = this._getReqId();

            if (typeof (callbacks) === 'undefined') {
                this._subscriptions[topicURI].callbacks = [];
                callbacks = {};
            } else if (typeof callbacks === 'function') {
                i = this._subscriptions[topicURI].callbacks.indexOf(callbacks);
                callbacks = {};
            } else if (callbacks.onEvent && typeof callbacks.onEvent === 'function') {
                i = this._subscriptions[topicURI].callbacks.indexOf(callbacks.onEvent);
            } else {
                this._subscriptions[topicURI].callbacks = [];
            }

            if (i >= 0) {
                this._subscriptions[topicURI].callbacks.splice(i, 1);
            }

            if (this._subscriptions[topicURI].callbacks.length) {
                // There are another callbacks for this topic
                this._cache.opStatus = WAMP_ERROR_MSG.SUCCESS;
                return this;
            }

            this._requests[reqId] = {
                topic: topicURI,
                callbacks
            };

            // WAMP_SPEC: [UNSUBSCRIBE, Request|id, SUBSCRIBED.Subscription|id]
            this._send([WAMP_MSG_SPEC.UNSUBSCRIBE, reqId, this._subscriptions[topicURI].id]);

        } else {
            this._cache.opStatus = WAMP_ERROR_MSG.NON_EXIST_UNSUBSCRIBE;

            if (typeof callbacks !== 'function' && _isPlainObject(callbacks) && callbacks.onError) {
                callbacks.onError({ error: this._cache.opStatus.description });
            }

            return this;
        }

        this._cache.opStatus = WAMP_ERROR_MSG.SUCCESS;
        this._cache.opStatus.reqId = reqId;
        return this;
    }

    /**
     * Publish a event to topic
     * @param {string} topicURI
     * @param {string|number|Array|object} payload - can be either a value of any type or null.  Also it
     *                          is possible to pass array and object-like data simultaneously.
     *                          In this case pass a hash-table with next attributes:
     *                          {
     *                             argsList: array payload (may be omitted)
     *                             argsDict: object payload (may be omitted)
     *                          }
     * @param {object} [callbacks] - optional hash table of callbacks:
     *                          { onSuccess: will be called when publishing would be confirmed
     *                            onError: will be called if publishing would be aborted }
     * @param {object} advancedOptions - optional parameter. Must include any or all of the options:
     *                          { exclude: integer|array WAMP session id(s) that won't receive a published event,
     *                                      even though they may be subscribed
     *                            exclude_authid: string|array Authentication id(s) that won't receive
     *                                      a published event, even though they may be subscribed
     *                            exclude_authrole: string|array Authentication role(s) that won't receive
     *                                      a published event, even though they may be subscribed
     *                            eligible: integer|array WAMP session id(s) that are allowed
     *                                      to receive a published event
     *                            eligible_authid: string|array Authentication id(s) that are allowed
     *                                      to receive a published event
     *                            eligible_authrole: string|array Authentication role(s) that are allowed
     *                                      to receive a published event
     *                            exclude_me: bool flag of receiving publishing event by initiator
     *                            disclose_me: bool flag of disclosure of publisher identity (its WAMP session ID)
     *                                      to receivers of a published event }
     * @returns {IWampy}
     */
    publish (
        topicURI: string,
        payload?: Payload,
        callbacks?: PublishCallbacksHash,
        advancedOptions?: any
    ) {
        let reqId, err = false, hasPayload = false;
        const options: Dict = {};


        if (!this._preReqChecks({ topic: topicURI, patternBased: false, allowWAMP: false }, 'broker', callbacks)) {
            return this;
        }

        if (_isPlainObject(callbacks)) {
            options.acknowledge = true;
        }

        if (typeof (advancedOptions) !== 'undefined') {
            const _optionsConvertHelper = (option: string, sourceType: string) => {
                if (advancedOptions[option]) {
                    if (_isArray(advancedOptions[option]) && advancedOptions[option].length) {
                        options[option] = advancedOptions[option];
                    } else if (typeof advancedOptions[option] === sourceType) {
                        options[option] = [advancedOptions[option]];
                    } else {
                        err = true;
                    }
                }
            };
            if (_isPlainObject(advancedOptions)) {
                _optionsConvertHelper('exclude', 'number');
                _optionsConvertHelper('exclude_authid', 'string');
                _optionsConvertHelper('exclude_authrole', 'string');
                _optionsConvertHelper('eligible', 'number');
                _optionsConvertHelper('eligible_authid', 'string');
                _optionsConvertHelper('eligible_authrole', 'string');

                if (advancedOptions.hasOwnProperty('exclude_me')) {
                    options.exclude_me = advancedOptions.exclude_me !== false;
                }

                if (advancedOptions.hasOwnProperty('disclose_me')) {
                    options.disclose_me = advancedOptions.disclose_me === true;
                }

            } else {
                err = true;
            }

            if (err) {
                this._cache.opStatus = WAMP_ERROR_MSG.INVALID_PARAM;

                if (_isPlainObject(callbacks) && callbacks.onError) {
                    callbacks.onError({ error: this._cache.opStatus.description });
                }

                return this;
            }
        }

        reqId = this._getReqId();

        switch (arguments.length) {
            case 1:
                break;
            case 2:
                hasPayload = true;
                break;
            default:
                this._requests[reqId] = {
                    topic: topicURI,
                    callbacks
                };
                hasPayload = true;
                break;
        }

        // WAMP_SPEC: [PUBLISH, Request|id, Options|dict, Topic|uri]
        const msg: Message = [WAMP_MSG_SPEC.PUBLISH, reqId, options, topicURI];

        if (hasPayload) {
            // WAMP_SPEC: [PUBLISH, Request|id, Options|dict, Topic|uri, Arguments|list (, ArgumentsKw|dict)]
            if (_isArray(payload)) {
                msg.push(payload);
            } else if (_isPlainObject(payload) && typeof payload === 'object') {
                // It's a wampy unified form of payload passing
                if (payload.argsList || payload.argsDict) {
                    if (payload.argsList) {
                        msg.push(payload.argsList);
                    }

                    if (payload.argsDict) {
                        if (msg.length === 4) {
                            msg.push([]);
                        }
                        msg.push(payload.argsDict);
                    }
                } else {
                    msg.push([], payload);
                }
            } else {    // assume it's a single value
                msg.push([payload]);
            }
        }

        this._send(msg);
        this._cache.opStatus = WAMP_ERROR_MSG.SUCCESS;
        this._cache.opStatus.reqId = reqId;
        return this;
    }

    /**
     * Remote Procedure Call
     * @param {string} topicURI
     * @param {string|number|Array|object} payload - can be either a value of any type or null.  Also it
     *                          is possible to pass array and object-like data simultaneously.
     *                          In this case pass a hash-table with next attributes:
     *                          {
     *                             argsList: array payload (may be omitted)
     *                             argsDict: object payload (may be omitted)
     *                          }
     * @param {function|object} callbacks - if it is a function - it will be treated as result callback function
     *                          or it can be hash table of callbacks:
     *                          { onSuccess: will be called with result on successful call
     *                            onError: will be called if invocation would be aborted }
     * @param {object} advancedOptions - optional parameter. Must include any or all of the options:
     *                          { disclose_me: bool flag of disclosure of Caller identity (WAMP session ID)
     *                                  to endpoints of a routed call
     *                            receive_progress: bool flag for receiving progressive results. In this case
     *                                  onSuccess function will be called every time on receiving result
     *                            timeout: integer timeout (in ms) for the call to finish }
     * @returns {IWampy}
     */
    call (topicURI: string,
        payload?: Payload,
        callbackOrCallbacks?: SuccessCallback | CallCallbacksHash,
        advancedOptions?: CallAdvancedOptions
    ): IWampy {
        let reqId, err = false;

        if (!this._preReqChecks({ topic: topicURI, patternBased: false, allowWAMP: true }, 'dealer', callbackOrCallbacks)) {
            return this;
        }

        const callbacks: CallCallbacksHash = typeof callbackOrCallbacks === 'function'
            ? { onSuccess: callbackOrCallbacks }
            : callbackOrCallbacks || {};

        if (typeof (callbacks.onSuccess) === 'undefined') {
            this._cache.opStatus = WAMP_ERROR_MSG.NO_CALLBACK_SPEC;

            if (_isPlainObject(callbacks) && callbacks.onError) {
                callbacks.onError({ error: this._cache.opStatus.description });
            }

            return this;
        }

        const options: CallAdvancedOptions = {};
        if (typeof (advancedOptions) !== 'undefined') {

            if (_isPlainObject(advancedOptions)) {
                if (advancedOptions.hasOwnProperty('disclose_me')) {
                    options.disclose_me = advancedOptions.disclose_me === true;
                }

                if (advancedOptions.hasOwnProperty('receive_progress')) {
                    options.receive_progress = advancedOptions.receive_progress === true;
                }

                if (advancedOptions.hasOwnProperty('timeout')) {
                    if (typeof advancedOptions.timeout === 'number') {
                        options.timeout = advancedOptions.timeout;
                    } else {
                        err = true;
                    }
                }

            } else {
                err = true;
            }

            if (err) {
                this._cache.opStatus = WAMP_ERROR_MSG.INVALID_PARAM;

                if (_isPlainObject(callbacks) && callbacks.onError) {
                    callbacks.onError({ error: this._cache.opStatus.description });
                }

                return this;
            }
        }

        do {
            reqId = this._getReqId();
        } while (reqId in this._calls);

        this._calls[reqId] = callbacks;

        // WAMP SPEC: [CALL, Request|id, Options|dict, Procedure|uri, (Arguments|list, ArgumentsKw|dict)]
        const msg: Message = [WAMP_MSG_SPEC.CALL, reqId, options, topicURI];

        if (payload !== null && typeof (payload) !== 'undefined') {
            if (_isArray(payload)) {
                msg.push(payload);
            } else if (_isPlainObject(payload) && typeof payload === 'object') {
                // It's a wampy unified form of payload passing
                if (payload.argsList || payload.argsDict) {
                    if (payload.argsList) {
                        msg.push(payload.argsList);
                    }

                    if (payload.argsDict) {
                        if (msg.length === 4) {
                            msg.push([]);
                        }
                        msg.push(payload.argsDict);
                    }
                } else {
                    msg.push([], payload);
                }
            } else {    // assume it's a single value
                msg.push([payload]);
            }
        }

        this._send(msg);
        if (callbacks.onReqId) {
            callbacks.onReqId(reqId);
        }

        this._cache.opStatus = WAMP_ERROR_MSG.SUCCESS;
        this._cache.opStatus.reqId = reqId;
        return this;
    }

    /**
     * RPC invocation cancelling
     *
     * @param {int} reqId RPC call request ID
     * @param {function|object} callbacks - if it is a function - it will be called if successfully
     *                          sent canceling message or it can be hash table of callbacks:
     *                          { onSuccess: will be called if successfully sent canceling message
     *                            onError: will be called if some error occurred }
     * @param {object} advancedOptions - optional parameter. Must include any or all of the options:
     *                          { mode: string|one of the possible modes:
     *                                  "skip" | "kill" | "killnowait". Skip is default.
     *                          }
     *
     * @returns {IWampy}
     */
    cancel (
        reqId: number,
        callbacks?: Callback | CancelCallbacksHash,
        advancedOptions?: CancelAdvancedOptions
    ) {
        let err = false;

        if (!this._preReqChecks(null, 'dealer', callbacks)) {
            return this;
        }

        if (!reqId || !this._calls[reqId]) {
            this._cache.opStatus = WAMP_ERROR_MSG.NON_EXIST_RPC_REQ_ID;

            if (_isPlainObject(callbacks) && typeof callbacks !== 'function' && callbacks.onError) {
                callbacks.onError({ error: this._cache.opStatus.description });
            }

            return this;
        }

        const options: CancelAdvancedOptions = {};
        if (typeof (advancedOptions) !== 'undefined') {

            if (_isPlainObject(advancedOptions)) {

                if (advancedOptions.hasOwnProperty('mode') && advancedOptions.mode) {
                    if (/skip|kill|killnowait/.test(advancedOptions.mode)) {
                        options.mode = advancedOptions.mode;
                    } else {
                        err = true;
                    }

                }
            } else {
                err = true;
            }

            if (err) {
                this._cache.opStatus = WAMP_ERROR_MSG.INVALID_PARAM;

                if (_isPlainObject(callbacks) && typeof callbacks !== 'function' && callbacks.onError) {
                    callbacks.onError({ error: this._cache.opStatus.description });
                }

                return this;
            }
        }

        // WAMP SPEC: [CANCEL, CALL.Request|id, Options|dict]
        this._send([WAMP_MSG_SPEC.CANCEL, reqId, options]);
        this._cache.opStatus = WAMP_ERROR_MSG.SUCCESS;
        this._cache.opStatus.reqId = reqId;

        typeof callbacks === 'object' && callbacks.onSuccess && callbacks.onSuccess();

        return this;
    }

    /**
     * RPC registration for invocation
     * @param {string} topicURI
     * @param {function|object} callbacks - if it is a function - it will be treated as rpc itself
     *                          or it can be hash table of callbacks:
     *                          { rpc: registered procedure
     *                            onSuccess: will be called on successful registration
     *                            onError: will be called if registration would be aborted }
     * @param {object} advancedOptions - optional parameter. Must include any or all of the options:
     *                          {
     *                              match: string matching policy ("prefix"|"wildcard")
     *                              invoke: string invocation policy ("single"|"roundrobin"|"random"|"first"|"last")
     *                          }
     * @returns {IWampy}
     */
    register (topicURI: string, callbacks: RPCCallback | RegisterCallbacksHash, advancedOptions?: RegisterAdvancedOptions) {
        let reqId, patternBased = false, err = false;
        const options: RegisterAdvancedOptions = {};

        if (typeof (advancedOptions) !== 'undefined') {

            if (_isPlainObject(advancedOptions)) {

                if (advancedOptions.match) {
                    if (/prefix|wildcard/.test(advancedOptions.match)) {
                        options.match = advancedOptions.match;
                        patternBased = true;
                    } else {
                        err = true;
                    }
                }

                if (advancedOptions.invoke) {
                    if (/single|roundrobin|random|first|last/.test(advancedOptions.invoke)) {
                        options.invoke = advancedOptions.invoke;
                    } else {
                        err = true;
                    }
                }

            } else {
                err = true;
            }

            if (err) {
                this._cache.opStatus = WAMP_ERROR_MSG.INVALID_PARAM;

                if (typeof callbacks !== 'function' && _isPlainObject(callbacks) && callbacks.onError) {
                    callbacks.onError({ error: this._cache.opStatus.description });
                }

                return this;
            }
        }

        if (!this._preReqChecks({ topic: topicURI, patternBased: patternBased, allowWAMP: false },
            'dealer',
            callbacks)) {
            return this;
        }

        if (typeof callbacks === 'function') {
            callbacks = { rpc: callbacks };
        } else if (!_isPlainObject(callbacks) || typeof (callbacks.rpc) === 'undefined') {
            this._cache.opStatus = WAMP_ERROR_MSG.NO_CALLBACK_SPEC;

            if (_isPlainObject(callbacks) && callbacks.onError) {
                callbacks.onError({ error: this._cache.opStatus.description });
            }

            return this;
        }

        if (!this._rpcRegs[topicURI] || !this._rpcRegs[topicURI].callbacks.length) {
            // no such registration or processing unregistering

            reqId = this._getReqId();

            this._requests[reqId] = {
                topic: topicURI,
                callbacks
            };

            // WAMP SPEC: [REGISTER, Request|id, Options|dict, Procedure|uri]
            this._send([WAMP_MSG_SPEC.REGISTER, reqId, options, topicURI]);
            this._cache.opStatus = WAMP_ERROR_MSG.SUCCESS;
            this._cache.opStatus.reqId = reqId;
        } else {    // already have registration with such topicURI
            this._cache.opStatus = WAMP_ERROR_MSG.RPC_ALREADY_REGISTERED;

            if (_isPlainObject(callbacks) && callbacks.onError) {
                callbacks.onError({ error: this._cache.opStatus.description });
            }

        }

        return this;

    }

    /**
     * RPC unregistration for invocation
     * @param {string} topicURI
     * @param {function|object} callbacks - if it is a function, it will be called on successful unregistration
     *                          or it can be hash table of callbacks:
     *                          { onSuccess: will be called on successful unregistration
     *                            onError: will be called if unregistration would be aborted }
     * @returns {IWampy}
     */
    unregister (topicURI: string, callbacks?: Callback | UnregisterCallbacksHash) {
        let reqId;

        if (!this._preReqChecks({ topic: topicURI, patternBased: false, allowWAMP: false }, 'dealer', callbacks)) {
            return this;
        }

        if (typeof callbacks === 'function') {
            callbacks = { onSuccess: callbacks };
        }

        if (this._rpcRegs[topicURI]) {   // there is such registration

            reqId = this._getReqId();

            this._requests[reqId] = {
                topic: topicURI,
                callbacks
            };

            // WAMP SPEC: [UNREGISTER, Request|id, REGISTERED.Registration|id]
            this._send([WAMP_MSG_SPEC.UNREGISTER, reqId, this._rpcRegs[topicURI].id]);
            this._cache.opStatus = WAMP_ERROR_MSG.SUCCESS;
            this._cache.opStatus.reqId = reqId;
        } else {    // there is no registration with such topicURI
            this._cache.opStatus = WAMP_ERROR_MSG.NON_EXIST_RPC_UNREG;

            if (_isPlainObject(callbacks) && callbacks.onError) {
                callbacks.onError({ error: this._cache.opStatus.description });
            }
        }

        return this;
    }
}

export function createWampy(options?: WampyOptions): IWampy;
export function createWampy(url: string, options?: WampyOptions): IWampy;

export function createWampy(urlOrOptions?: WampyOptions | string, options?: WampyOptions): IWampy {
    return new Wampy(urlOrOptions, options);
}
