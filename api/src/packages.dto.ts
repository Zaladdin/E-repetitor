import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, IsUUID, Length, Max, Min, ValidateIf } from 'class-validator';
import { ConnectionPageDto } from './connections.dto';
import { PaymentCurrency, PaymentVersionDto } from './payments.dto';

const optional = (_object: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.normalize('NFC').trim() : value;
const lower = ({ value }: { value: unknown }) => typeof value === 'string' ? value.toLowerCase() : value;

export class PackageRoleQueryDto extends ConnectionPageDto {
  @ApiProperty({ enum: ['teacher', 'student', 'parent'] }) @IsIn(['teacher', 'student', 'parent']) role!: 'teacher' | 'student' | 'parent';
}
export class PackageQueryDto extends PackageRoleQueryDto {
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(optional) @Transform(lower) @IsUUID('4') enrollmentId?: string;
}
export class CreatePackageDto {
  @ApiProperty({ format: 'uuid' }) @Transform(lower) @IsUUID('4') requestId!: string;
  @ApiProperty({ format: 'uuid' }) @Transform(lower) @IsUUID('4') enrollmentId!: string;
  @ApiProperty({ minLength: 1, maxLength: 200 }) @Transform(trim) @IsString() @Length(1, 200) title!: string;
  @ApiProperty({ minimum: 1, maximum: 1000 }) @IsInt() @Min(1) @Max(1000) lessonCount!: number;
  @ApiProperty({ minimum: 1, maximum: 999999999 }) @IsInt() @Min(1) @Max(999999999) amountMinor!: number;
  @ApiProperty({ enum: ['AZN', 'RUB', 'USD', 'EUR'] }) @IsIn(['AZN', 'RUB', 'USD', 'EUR']) currency!: PaymentCurrency;
}
export class ChargePackageDto extends PaymentVersionDto {
  @ApiProperty({ format: 'uuid' }) @Transform(lower) @IsUUID('4') requestId!: string;
  @ApiProperty({ format: 'uuid' }) @Transform(lower) @IsUUID('4') lessonId!: string;
  @ApiProperty({ minimum: 1, maximum: 2147483646 }) @IsInt() @Min(1) @Max(2147483646) lessonVersion!: number;
  @ApiPropertyOptional({ minLength: 3, maxLength: 1000, description: 'Private teacher reason, required for an absent student.' })
  @ValidateIf(optional) @Transform(trim) @IsString() @Length(3, 1000) reason?: string;
}
export class ReversePackageDto extends PaymentVersionDto {
  @ApiProperty({ format: 'uuid' }) @Transform(lower) @IsUUID('4') requestId!: string;
  @ApiProperty({ format: 'uuid' }) @Transform(lower) @IsUUID('4') entryId!: string;
  @ApiProperty({ minLength: 3, maxLength: 1000, description: 'Private teacher correction reason.' })
  @Transform(trim) @IsString() @Length(3, 1000) reason!: string;
}
export class ClosePackageDto extends PaymentVersionDto {
  @ApiProperty({ minLength: 3, maxLength: 1000, description: 'Private reason; unused lessons remain in the history.' })
  @Transform(trim) @IsString() @Length(3, 1000) reason!: string;
}
export class PackageView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) enrollmentId!: string;
  @ApiProperty() studentName!: string;
  @ApiProperty() studentPublicId!: string;
  @ApiProperty() teacherName!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty() title!: string;
  @ApiProperty() lessonCount!: number;
  @ApiProperty() balance!: number;
  @ApiProperty() paid!: boolean;
  @ApiProperty() cancelled!: boolean;
  @ApiProperty() closed!: boolean;
  @ApiProperty() amountMinor!: number;
  @ApiProperty({ enum: ['AZN', 'RUB', 'USD', 'EUR'] }) currency!: PaymentCurrency;
  @ApiPropertyOptional({ format: 'date-time' }) paidMarkedAt?: string;
  @ApiProperty({ description: 'Package version for charges, reversals and closure.' }) version!: number;
  @ApiProperty({ description: 'Payment version for the existing manual paid-status endpoint.' }) paymentVersion!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class PackagePage {
  @ApiProperty({ type: [PackageView] }) items!: PackageView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class PackageLessonView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty() durationMin!: number;
  @ApiProperty({ enum: ['completed', 'student_absent'] }) status!: 'completed' | 'student_absent';
  @ApiProperty() version!: number;
}
export class PackageLessonPage {
  @ApiProperty({ type: [PackageLessonView] }) items!: PackageLessonView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class PackageHistoryView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['created', 'charged', 'reversed', 'closed'] }) type!: 'created' | 'charged' | 'reversed' | 'closed';
  @ApiProperty() delta!: number;
  @ApiPropertyOptional({ format: 'uuid' }) lessonId?: string;
  @ApiPropertyOptional({ format: 'date-time' }) lessonStartsAt?: string;
  @ApiPropertyOptional({ format: 'uuid' }) reversesEntryId?: string;
  @ApiPropertyOptional() reversed?: boolean;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiPropertyOptional({ description: 'Only the owning teacher.' }) actorName?: string;
  @ApiPropertyOptional({ description: 'Only the owning teacher.' }) reason?: string;
}
export class PackageHistoryPage {
  @ApiProperty({ type: [PackageHistoryView] }) items!: PackageHistoryView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
