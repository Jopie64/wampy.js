export type Dict = {[key: string]: any};

export type Callback = () => void;

export type ErrorCallback = (args: ErrorArgs) => void;

export type WsErrorCallback = (args: WsErrorArgs) => void;

export type EventCallback = (args: DataArgs) => void;

export type SuccessCallback = (args: DataArgs) => void;

export type RPCCallback = (args: DataArgs) => PromiseLike<RPCResult | void> | RPCResult | void;

export type ChallengeCallback = (auth_method: string, extra: Dict) => string;

export type Payload = Args | Dict | string | number | boolean | any[] | null;

export interface Args
{
    argsList: any[];
    argsDict: Dict;
}

export interface ErrorArgs
{
    error: string;
    details?: Dict;
}

export interface WsErrorArgs extends ErrorArgs
{
    event?: Event;
}

export interface DataArgs extends Args
{
    details: Dict;
}

export interface RPCOptions
{
    process?: boolean;
}

export interface RPCResult extends Args
{
    options: RPCOptions;
}

export interface SubscribeCallbacksHash
{
    onSuccess?: Callback;
    onError?: ErrorCallback;
    onEvent?: EventCallback;
}

export interface UnsubscibeCallbacksHash extends SubscribeCallbacksHash
{

}

export interface PublishCallbacksHash
{
    onSuccess?: Callback;
    onError?: ErrorCallback;
}

export interface CallCallbacksHash
{
    onSuccess?: SuccessCallback;
    onError?: ErrorCallback;
    onReqId?: (reqId: number) => void;
}

export interface CancelCallbacksHash
{
    onSuccess?: Callback;
    onError?: ErrorCallback;
}

export interface RegisterCallbacksHash
{
    rpc: RPCCallback;
    onSuccess?: Callback;
    onError?: ErrorCallback;
}

export interface UnregisterCallbacksHash
{
    onSuccess?: Callback;
    onError?: ErrorCallback;
}

export interface AdvancedOptions
{
    exclude?: number | number[];
    eligible?: number | number[];
    exclude_me?: boolean;
    disclose_me?: boolean;
}

export interface PublishAdvancedOptions extends AdvancedOptions
{
    exclude_authid?: string | string[];
    exclude_authrole?: string | string[];
    eligible_authid?: string | string[];
    eligible_authrole?: string | string[];
}

export interface SubscribeAdvancedOptions
{
    match?: 'prefix' | 'wildcard';
}

export interface CallAdvancedOptions
{
    disclose_me?: boolean;
    receive_progress?: boolean;
    timeout?: number;
}

export interface CancelAdvancedOptions
{
    mode?: "skip" | "kill" | "killnowait";
}

export interface RegisterAdvancedOptions
{
    match?: "prefix" | "wildcard"
    invoke?: "single" | "roundrobin" | "random" | "first" | "last"
}

export interface NewableWebSocket {
    new(...args: any[]): WebSocket;
}

export interface WampyOptions
{
    autoReconnect?: boolean;
    reconnectInterval?: number;
    maxRetries?: number;
    realm?: string;
    helloCustomDetails?: any;
    uriValidation?: 'strict' | 'loose';
    authid?: string;
    authmethods?: string[];
    onChallenge?: ChallengeCallback;
    onConnect?: SuccessCallback;
    onClose?: Callback;
    onError?: WsErrorCallback;
    onReconnect?: Callback;
    onReconnectSuccess?: SuccessCallback;
    ws?: NewableWebSocket;
    additionalHeaders?: {[key: string]: string};
    wsRequestOptions?: any;
    serializer?: any;
    debug?: boolean;
}

export interface WampyOpStatus
{
    code: number;
    description: string;
    reqId?: number;
}

export interface IWampy
{
    options(opts?: WampyOptions): WampyOptions | IWampy;
    getOpStatus(): WampyOpStatus;
    getSessionId(): number;
    connect(url?: string): IWampy;
    disconnect(): IWampy;
    abort(): IWampy;
    subscribe(topicURI: string,
              callbacks: EventCallback | SubscribeCallbacksHash,
              advancedOptions?: SubscribeAdvancedOptions): IWampy;
    unsubscribe(topicURI: string,
                callbacks?: EventCallback | UnsubscibeCallbacksHash): IWampy;
    publish(topicURI: string,
            payload?: Payload,
            callbacks?: PublishCallbacksHash,
            advancedOptions?: PublishAdvancedOptions): IWampy;
    call(topicURI: string,
         payload?: Payload,
         callbacks?: SuccessCallback | CallCallbacksHash,
         advancedOptions?: CallAdvancedOptions): IWampy;
    cancel(reqId: number,
           callbacks?: Callback | CancelCallbacksHash,
           advancedOptions?: CancelAdvancedOptions): IWampy;
    register(topicURI: string,
             callbacks: RPCCallback | RegisterCallbacksHash,
             avdancedOptions?: RegisterAdvancedOptions): IWampy;
    unregister(topicURI: string,
               callbacks?: Callback | UnregisterCallbacksHash): IWampy;
}
