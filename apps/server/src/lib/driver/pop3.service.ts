import POP3Client from 'poplib';

export interface Pop3Config {
  host: string;
  port: number;
  tls: boolean;
  auth: { user: string; pass: string };
}

export class Pop3Service {
  private client: POP3Client | null = null;
  private connected = false;
  constructor(private config: Pop3Config) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new POP3Client(this.config.port, this.config.host, {
        tlserrs: false,
        enabletls: this.config.tls,
        debug: false,
      });
      this.client = client;
      client.on('error', (err: Error) => reject(err));
      client.on('connect', () => {
        client.login(this.config.auth.user, this.config.auth.pass);
      });
      client.on('login', (status: boolean, rawdata: string) => {
        if (status) {
          this.connected = true;
          resolve();
        } else {
          reject(new Error('POP3 login failed: ' + rawdata));
        }
      });
    });
  }

  private async connectIfNeeded() {
    if (!this.connected) {
      await this.connect();
    }
  }

  listMessages(): Promise<number[]> {
    return new Promise(async (resolve, reject) => {
      if (!this.client) return reject(new Error('Not connected'));
      await this.connectIfNeeded();
      this.client.list();
      const numbers: number[] = [];
      const client = this.client;
      const onList = (status: boolean, msgcount: number, msgnumber: number, data: string) => {
        if (status) {
          for (let i = 0; i < msgcount; i++) numbers.push(i + 1);
          resolve(numbers);
        } else {
          reject(new Error('POP3 LIST failed'));
        }
        client.removeListener('list', onList);
      };
      client.on('list', onList);
    });
  }

  fetchMessage(id: number): Promise<string> {
    return new Promise(async (resolve, reject) => {
      if (!this.client) return reject(new Error('Not connected'));
      await this.connectIfNeeded();
      this.client.retr(id);
      let data = '';
      const client = this.client;
      const onRetr = (status: boolean, msgnumber: number, rawdata: string, dataBuffer: Buffer) => {
        if (status) {
          resolve(dataBuffer.toString());
        } else {
          reject(new Error('POP3 RETR failed: ' + rawdata));
        }
        client.removeListener('retr', onRetr);
      };
      client.on('retr', onRetr);
    });
  }

  quit() {
    this.client?.quit();
    this.client = null;
  }
}
