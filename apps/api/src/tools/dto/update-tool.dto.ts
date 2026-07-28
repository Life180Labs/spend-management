import { IsString, IsOptional, IsNumber, IsEmail, IsDateString } from 'class-validator';

export class UpdateToolDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() vendor?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() paymentKind?: string;
  @IsOptional() @IsString() billingCycle?: string;
  @IsOptional() @IsNumber() capAmount?: number;
  @IsOptional() @IsNumber() monthlyAmount?: number;
  @IsOptional() @IsNumber() alertThresholdPct?: number;
  @IsOptional() @IsEmail() triggerEmail?: string;
  @IsOptional() @IsDateString() renewalDate?: string;
}
