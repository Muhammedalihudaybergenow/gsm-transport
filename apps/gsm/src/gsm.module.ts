import { Module } from '@nestjs/common';
import { GsmController } from './controllers/gsm.controller';
import { MessagesService } from './services';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { MailService } from './services/mail.service';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
  ],
  controllers: [GsmController],
  providers: [MessagesService, MailService],
})
export class GsmModule {}
