import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import * as amqp from 'amqp-connection-manager';
import { ChannelWrapper } from 'amqp-connection-manager';
import { ConfirmChannel } from 'amqplib';
import * as brokerModule from './broker.module';

@Injectable()
export class BrokerService implements OnModuleDestroy {
  private connection: amqp.AmqpConnectionManager;
  private channelWrapper: ChannelWrapper;

  constructor(
    @Inject('BROKER_OPTIONS') private options: brokerModule.BrokerOptions,
  ) {
    this.connectToBroker();
  }

  private connectToBroker() {
    const { host, port, username = 'guest', password = 'guest' } = this.options;
    const connectionUrl = `amqp://${username}:${password}@${host}:${port}`;

    // Create connection manager
    this.connection = amqp.connect([connectionUrl], {
      reconnectTimeInSeconds: 5,
      heartbeatIntervalInSeconds: 5,
    });

    // Handle connection events
    this.connection.on('connect', () => {
      console.log('Successfully connected to RabbitMQ');
    });

    this.connection.on('disconnect', (err) => {
      console.error(
        'Disconnected from RabbitMQ:',
        err?.err?.message || 'Unknown error',
      );
    });

    this.connection.on('connectFailed', (err) => {
      console.error(
        'Failed to connect to RabbitMQ:',
        err?.err?.message || 'Unknown error',
      );
    });

    // Create a channel wrapper
    this.channelWrapper = this.connection.createChannel({
      json: false,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      setup: (_channel: ConfirmChannel) => {
        // Here you can set up exchanges, queues, bindings etc.
        console.log('Channel created and ready');
        return;
      },
    });

    this.channelWrapper.on('error', (err) => {
      console.error('Channel error:', err);
    });
  }

  // Send a message to a queue
  async sendMessage(queue: string, message: string): Promise<void> {
    try {
      await this.channelWrapper.assertQueue(queue, { durable: true });
      await this.channelWrapper.sendToQueue(queue, Buffer.from(message), {
        persistent: true,
      });
    } catch (error) {
      console.error(`Failed to send message to queue ${queue}:`, error);
      throw error;
    }
  }

  // Publish a message to an exchange
  async publish(
    exchange: string,
    routingKey: string,
    message: any,
  ): Promise<void> {
    try {
      await this.channelWrapper.assertExchange(exchange, 'topic', {
        durable: true,
      });
      await this.channelWrapper.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(message)),
        {
          persistent: true,
        },
      );
      console.log(
        `Message published to exchange ${exchange} with routing key ${routingKey}`,
      );
    } catch (error) {
      console.error(`Failed to publish message:`, error);
      throw error;
    }
  }

  // Get the channel wrapper for advanced usage
  getChannelWrapper(): ChannelWrapper {
    return this.channelWrapper;
  }

  // Get the connection manager for advanced usage
  getConnection(): amqp.AmqpConnectionManager {
    return this.connection;
  }

  // Gracefully close connections
  async onModuleDestroy() {
    try {
      await this.channelWrapper.close();
      await this.connection.close();
      console.log('RabbitMQ connections closed');
    } catch (error) {
      console.error('Error closing RabbitMQ connections:', error);
    }
  }
}
