import { MessagingService, QUEUE_NAMES } from '@libs/broker';
import { Injectable } from '@nestjs/common';
import { CreateAuthMessageDto } from '../dtos';

@Injectable()
export class AuthService {
  constructor(private messagingService: MessagingService) {}

  sendSms(dto: CreateAuthMessageDto) {
    return this.messagingService.sendMessage(
      QUEUE_NAMES.GSM_SENDER,
      'send_sms',
      {
        ...dto,
      },
    );
  }
}
