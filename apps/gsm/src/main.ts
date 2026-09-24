import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as dotenv from 'dotenv';
import { join } from 'path';
import { GsmModule } from './gsm.module';

dotenv.config({
  path: join(process.cwd(), '.env'),
});

async function bootstrap() {
  const logger = new Logger('GSM Microservice');

  const natsHost = process.env.NATS_HOST || 'localhost';
  const natsPort = Number(process.env.NATS_PORT || 4222);

  const connectionUrl = `nats://${natsHost}:${natsPort}`;

  const natsOptions: Record<string, any> = {
    servers: [connectionUrl],
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 5000,
    waitOnFirstConnect: true,
    timeout: 10000,
  };

  logger.log(`Connecting to NATS: ${connectionUrl}`);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    GsmModule,
    {
      transport: Transport.NATS,
      options: {
        ...natsOptions,
        queue: process.env.NATS_QUEUE || 'gsm_queue',
      },
    },
  );

  app
    .listen()
    .then(() => {
      logger.log('GSM Microservice is listening...');
      logger.log(`NATS Server: ${connectionUrl}`);
      logger.log(`NATS Queue: ${process.env.NATS_QUEUE || 'gsm_queue'}`);
    })
    .catch((error) => {
      logger.error('Failed to start GSM Microservice', error);
      process.exit(1);
    });
}

bootstrap().catch((error) => {
  console.error('Bootstrap failed:', error);
  process.exit(1);
});
