import { IsString, IsOptional, IsNumber, IsEmail, IsDateString, IsEnum } from 'class-validator';

export class CreateToolDto {
  @IsString()
  name: string;

  @IsString()
  departmentId: string;

  @IsOptional() @IsString()
  vendor?: string;

  @IsOptional() @IsString()
  category?: string;

  @IsOptional() @IsString()
  paymentKind?: string;

  @IsOptional() @IsString()
  billingCycle?: string;

  @IsOptional() @IsNumber()
  capAmount?: number;

  @IsOptional() @IsNumber()
  monthlyAmount?: number;

  @IsOptional() @IsNumber()
  alertThresholdPct?: number;

  @IsOptional() @IsEmail()
  triggerEmail?: string;

  @IsOptional() @IsDateString()
  renewalDate?: string;

  // Only meaningful when paymentKind is ONETIME - the date the (one-off, non-
  // recurring) payment was made. Not stored on the Tool itself; ToolsService.create
  // uses it to log a single billing_records row for that month. Defaults to
  // today if omitted.
  @IsOptional() @IsDateString()
  oneTimePaidAt?: string;
}
