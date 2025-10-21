import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { BasicAuthGuard } from '../guards';
import { CreateAuthMessageDto } from '../dtos';
import { AuthService } from '../services';

@Controller({
  path: 'auth',
})
export class AuthController {
  constructor(private authService: AuthService) {}
  @Post('send-sms')
  @UseGuards(BasicAuthGuard)
  sendSms(@Body() body: CreateAuthMessageDto) {
    return this.authService.sendSms(body);
  }
}
