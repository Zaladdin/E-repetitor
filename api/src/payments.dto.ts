import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsString, IsUUID, Length, Max, Min, ValidateIf } from 'class-validator';
import { ConnectionPageDto } from './connections.dto';

const optional = (_object: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.normalize('NFC').trim() : value;
const lower = ({ value }: { value: unknown }) => typeof value === 'string' ? value.toLowerCase() : value;
export type PaymentCurrency = 'AZN' | 'RUB' | 'USD' | 'EUR';

export class PaymentQueryDto extends ConnectionPageDto {
  @ApiProperty({ enum: ['teacher', 'student', 'parent'] }) @IsIn(['teacher', 'student', 'parent']) role!: 'teacher' | 'student' | 'parent';
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(optional) @Transform(lower) @IsUUID('4') enrollmentId?: string;
  @ApiPropertyOptional({ enum: ['paid', 'unpaid', 'cancelled'] }) @ValidateIf(optional) @IsIn(['paid', 'unpaid', 'cancelled']) status?: 'paid' | 'unpaid' | 'cancelled';
}
export class CreatePaymentRecordDto {
  @ApiProperty({ format: 'uuid', description: 'Stable UUID for retrying this creation only.' }) @Transform(lower) @IsUUID('4') requestId!: string;
  @ApiProperty({ format: 'uuid' }) @Transform(lower) @IsUUID('4') enrollmentId!: string;
  @ApiProperty({ minLength: 1, maxLength: 200 }) @Transform(trim) @IsString() @Length(1, 200) title!: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 999999999, description: 'Integer minor units; currency is required when supplied.' })
  @ValidateIf(optional) @IsInt() @Min(1) @Max(999999999) amountMinor?: number;
  @ApiPropertyOptional({ enum: ['AZN', 'RUB', 'USD', 'EUR'], description: 'Must be supplied together with amountMinor.' })
  @ValidateIf(optional) @IsIn(['AZN', 'RUB', 'USD', 'EUR']) currency?: PaymentCurrency;
}
export class PaymentVersionDto {
  @ApiProperty({ minimum: 1, maximum: 2147483646 }) @IsInt() @Min(1) @Max(2147483646) version!: number;
}
export class MarkPaymentDto extends PaymentVersionDto {
  @ApiProperty({ description: 'Desired status, never a blind toggle. Only the owning teacher can change it.' }) @IsBoolean() paid!: boolean;
  @ApiPropertyOptional({ minLength: 3, maxLength: 1000, description: 'Teacher-only correction reason. Required when unmarking a paid record.' })
  @ValidateIf(optional) @Transform(trim) @IsString() @Length(3, 1000) reason?: string;
}
export class CancelPaymentDto extends PaymentVersionDto {
  @ApiProperty({ minLength: 3, maxLength: 1000, description: 'Teacher-only reason. Cancels an unpaid record; does not refund any money.' })
  @Transform(trim) @IsString() @Length(3, 1000) reason!: string;
}
export class PaymentRecordView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) enrollmentId!: string;
  @ApiProperty() studentName!: string;
  @ApiProperty() studentPublicId!: string;
  @ApiProperty() teacherName!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 999999999 }) amountMinor?: number;
  @ApiPropertyOptional({ enum: ['AZN', 'RUB', 'USD', 'EUR'] }) currency?: PaymentCurrency;
  @ApiProperty() paid!: boolean;
  @ApiProperty() cancelled!: boolean;
  @ApiProperty() version!: number;
  @ApiPropertyOptional({ format: 'date-time', description: 'Time the teacher marked this record paid, not the bank payment time.' }) paidMarkedAt?: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
export class PaymentRecordPage {
  @ApiProperty({ type: [PaymentRecordView] }) items!: PaymentRecordView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class PaymentHistoryView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['created', 'marked_paid', 'marked_unpaid', 'cancelled'] }) type!: 'created' | 'marked_paid' | 'marked_unpaid' | 'cancelled';
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty() actorName!: string;
  @ApiPropertyOptional() beforePaid?: boolean;
  @ApiProperty() afterPaid!: boolean;
  @ApiPropertyOptional({ description: 'Only the owning teacher.' }) reason?: string;
  @ApiPropertyOptional({ format: 'date-time' }) previousPaidMarkedAt?: string;
}
export class PaymentHistoryPage {
  @ApiProperty({ type: [PaymentHistoryView] }) items!: PaymentHistoryView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
