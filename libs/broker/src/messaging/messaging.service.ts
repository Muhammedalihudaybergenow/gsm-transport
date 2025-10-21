import { Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Observable } from 'rxjs';

@Injectable()
export class MessagingService {
  private clients = new Map<string, ClientProxy>();
  // Register a client for a specific queue
  registerClient(name: string, client: ClientProxy) {
    this.clients.set(name, client);
  }

  // Emit message to a specific queue by its client name
  emitMessage(clientName: string, queueName: string, payload: any) {
    const client = this.clients.get(clientName);
    if (!client) {
      throw new Error(`No client found for ${clientName}`);
    }

    return client.emit(queueName, payload).subscribe({
      complete: () => console.log(`Message sent to queue: ${queueName}`),
      error: (err) =>
        console.error(`Error sending message to queue: ${queueName}`, err),
    });
  }

  sendMessage(
    clientName: string,
    queueName: string,
    payload: any,
  ): Observable<any> {
    const client = this.clients.get(clientName);
    if (!client) {
      throw new Error(`No client found for ${clientName}`);
    }
    return client.send(queueName, payload);
  }
}
