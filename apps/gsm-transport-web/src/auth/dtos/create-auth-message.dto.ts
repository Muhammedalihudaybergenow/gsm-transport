import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';

export class CreateAuthMessageDto {
  @IsNotEmpty()
  @IsString()
  payload: string;

  @IsNotEmpty()
  @IsInt()
  @Min(61000000)
  @Max(71999999)
  phonenumber: number;
}
