import { Controller, Get } from '@nestjs/common';
import { MessagesService } from '../services/gsm.service';
import { EventPattern, MessagePattern, Payload } from '@nestjs/microservices';

@Controller()
export class GsmController {
  constructor(private readonly gsmService: MessagesService) {}

  @MessagePattern('send-sms')
  async sendSMS(@Payload() data: { phonenumber: number; payload: string }) {
    return this.gsmService.sendSms({
      payload: data.payload,
      phonenumber: data.phonenumber,
    });
  }
}
