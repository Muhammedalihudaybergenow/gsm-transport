import { MessagingModule, QUEUE_NAMES } from '@libs/broker';
import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    MessagingModule.register(
      [
        {
          name: QUEUE_NAMES.GSM_SENDER,
          queue: QUEUE_NAMES.GSM_SENDER,
        },
      ],
      {
        host: process.env.RABBITMQ_HOST || 'localhost',
        port: parseInt(process.env.RABBITMQ_PORT || '5432'),
        username: process.env.RABBITMQ_USERNAME,
        password: process.env.RABBITMQ_PASSWORD,
      },
    ),
    AuthModule,
  ],
})
export class AppModule {}
