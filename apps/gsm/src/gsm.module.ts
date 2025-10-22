import { Module } from '@nestjs/common';
import { GsmController } from './controllers/gsm.controller';
import { MessagesService } from './services';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
    }),
  ],
  controllers: [GsmController],
  providers: [MessagesService],
})
export class GsmModule {}
