import { DynamicModule, Module } from '@nestjs/common';
import {
  ClientProxy,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import { BrokerOptions } from '../broker.module';
import { MessagingService } from './messaging.service';
interface QueueConfig {
  name: string; // A unique name for the client
  queue: string; // Queue name
}
@Module({})
export class MessagingModule {
  static register(
    queues: QueueConfig[],
    connection: BrokerOptions,
  ): DynamicModule {
    const providers = queues.map((queue) => ({
      provide: queue.name,
      useFactory: () =>
        ClientProxyFactory.create({
          transport: Transport.RMQ,
          options: {
            urls: [
              `amqp://${connection.username}:${connection.password}@${connection.host}:${connection.port}`,
            ],
            queue: queue.queue,
            queueOptions: {
              durable: true,
            },
          },
        }),
    }));

    return {
      global: true,
      module: MessagingModule,
      providers: [
        MessagingService,
        ...providers,
        {
          provide: 'REGISTER_CLIENTS',
          useFactory: (
            MessagingService: MessagingService,
            ...clients: ClientProxy[]
          ) => {
            queues.forEach((queue, index) => {
              MessagingService.registerClient(queue.name, clients[index]);
            });
          },
          inject: [MessagingService, ...queues.map((q) => q.name)],
        },
      ],
      exports: [MessagingService],
    };
  }
}
