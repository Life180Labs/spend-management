import { IsString } from 'class-validator';

export class CompleteGoogleSignInDto {
  @IsString()
  token: string;
}
