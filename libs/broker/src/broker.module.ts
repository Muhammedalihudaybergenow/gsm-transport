import { DynamicModule, Global, Logger, Module } from '@nestjs/common';
import * as amqp from 'amqp-connection-manager';
import { BrokerService } from './broker.service';

export interface BrokerOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

@Global() // Makes the module globally available, optional
@Module({})
export class BrokerModule {
  static forRoot(options: BrokerOptions): DynamicModule {
    return {
      module: BrokerModule,
      providers: [
        {
          provide: 'BROKER_OPTIONS',
          useValue: options,
        },
        BrokerService,
      ],
      exports: [BrokerService],
    };
  }

  static async connectionCheck() {
    const logger = new Logger('BrokerModule');
    const rabbitMQOptions = {
      host: process.env.RABBITMQ_HOST || 'localhost',
      port: process.env.RABBITMQ_PORT || 5672,
      username: process.env.RABBITMQ_USERNAME || 'guest',
      password: process.env.RABBITMQ_PASSWORD || 'guest',
    };

    // Retry logic for RabbitMQ connection
    const maxAttempts = 10;
    let attempt = 0;
    let connected = false;

    while (attempt < maxAttempts && !connected) {
      try {
        const connectionUrl = `amqp://${rabbitMQOptions.username}:${rabbitMQOptions.password}@${rabbitMQOptions.host}:${rabbitMQOptions.port}`;
        logger.log(`Attempting to connect to RabbitMQ at ${connectionUrl}...`);

        // Try to connect to RabbitMQ broker
        const connection = amqp.connect(connectionUrl);
        connection.on('connect', () => {
          logger.log('Successfully connected to RabbitMQ!');
        });
        connection.on('disconnect', (err) => {
          logger.error(
            'Disconnected from RabbitMQ:',
            err?.err?.message || 'Unknown error',
          );
        });
        logger.log('Successfully connected to RabbitMQ!');
        connected = true;
      } catch (error) {
        attempt++;
        logger.error(
          `RabbitMQ connection attempt ${attempt} failed: ${error.message}`,
        );

        if (attempt < maxAttempts) {
          logger.log(`Retrying in 5 second...`);
          await new Promise((resolve) => setTimeout(resolve, 5000)); // Retry after 5 second
        } else {
          logger.error('Max attempts reached. Could not connect to RabbitMQ.');
          throw new Error('Could not connect to RabbitMQ after 10 attempts');
        }
      }
    }
  }
}
