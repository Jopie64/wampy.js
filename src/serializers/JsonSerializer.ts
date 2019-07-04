export class JsonSerializer {

    protocol = 'json';
    isBinary = true;

    constructor () {
    }

    encode (data: any) {
        return JSON.stringify(data);
    }

    decode (data: string) {
        return new Promise(resolve => {
            resolve(JSON.parse(data));
        });
    }
}
