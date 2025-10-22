import { QUEUE_NAMES } from '@libs/broker';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import * as amqp from 'amqplib';
import * as dotenv from 'dotenv';
import { join } from 'path';
import { GsmModule } from './gsm.module';
dotenv.config({
  path: join(process.cwd(), '.env'),
});
async function bootstrap() {
  const logger = new Logger('Menus Microservice');
  const rabbitMQOptions = {
    host: process.env.RABBITMQ_REMOTE_HOST || 'localhost',
    port: process.env.RABBITMQ_REMOTE_PORT || 5672,
    username: process.env.RABBITMQ_USERNAME || 'guest',
    password: process.env.RABBITMQ_PASSWORD || 'guest',
  };
  console.log('RabbitMQ Options:', rabbitMQOptions);
  async function wait(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  async function ensureRabbitMQConnection(url: string, logger: Logger) {
    while (true) {
      try {
        const conn = await amqp.connect(url);
        logger.log('Connected to RabbitMQ successfully');
        conn.on('close', async () => {
          await wait(30000);
          await ensureRabbitMQConnection(url, logger);
        });
        conn.on('error', (err) => {
          logger.error('RabbitMQ connection error:', err.message);
        });
        conn.close();
        break;
      } catch (err) {
        logger.error(`Failed to connect to RabbitMQ: ${err.message}`);
        logger.log('Retrying in 30 seconds...');
        await wait(30000);
      }
    }
  }
  const connectionUrl = `amqp://${rabbitMQOptions.username}:${rabbitMQOptions.password}@${rabbitMQOptions.host}:${rabbitMQOptions.port}`;
  await ensureRabbitMQConnection(connectionUrl, logger);
  // Now that the connection is successful, start the microservice
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    GsmModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [connectionUrl],

        queue: QUEUE_NAMES.GSM_SENDER,
        queueOptions: {
          durable: true,
        },
        maxConnectionAttempts: 10,
      },
    },
  );
  await app.listen();
  logger.log('Microservice is listening GSM...');
}
bootstrap().catch(console.error);
