import { Module } from '@nestjs/common';
import { GsmController } from './controllers/gsm.controller';
import { MessagesService } from './services';

@Module({
  imports: [],
  controllers: [GsmController],
  providers: [MessagesService],
})
export class GsmModule {}
