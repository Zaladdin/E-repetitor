import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, IsUUID, Length, Max, MaxLength, Min, Validate, ValidateIf, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { ConnectionPageDto } from './connections.dto';

/** Calendar validation precedes Date parsing, which otherwise normalizes February 30. */
export function isOffsetDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (!year || !month || month > 12 || !day || hour! > 23 || minute! > 59 || second! > 59) return false;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]!) return false;
  const zone = match[7]!;
  // PostgreSQL timestamptz supports numeric timezone displacements up to 15:59.
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 15 || Number(zone.slice(4)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}
@ValidatorConstraint({ name: 'offsetDateTime' })
class OffsetDateTime implements ValidatorConstraintInterface {
  validate(value: unknown) { return isOffsetDateTime(value); }
  defaultMessage() { return 'Укажите существующую дату и время с часовым поясом.'; }
}
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.normalize('NFC').trim() : value;
const optional = (_object: unknown, value: unknown) => value !== undefined;

export class LessonQueryDto extends ConnectionPageDto {
  @ApiProperty({ enum: ['teacher', 'student', 'parent'] }) @IsIn(['teacher', 'student', 'parent']) role!: 'teacher' | 'student' | 'parent';
  @ApiProperty({ format: 'date-time' }) @Validate(OffsetDateTime) from!: string;
  @ApiProperty({ format: 'date-time' }) @Validate(OffsetDateTime) to!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(optional) @IsUUID('4') enrollmentId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(optional) @IsUUID('4') studentId?: string;
}
export class LessonTimeDto {
  @ApiProperty({ format: 'date-time' }) @Validate(OffsetDateTime) startsAt!: string;
  @ApiProperty({ minimum: 5, maximum: 480 }) @IsInt() @Min(5) @Max(480) durationMin!: number;
}
export class CreateLessonDto extends LessonTimeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') enrollmentId!: string;
  @ApiProperty({ format: 'uuid', description: 'Stable UUID for retrying this creation only.' }) @IsUUID('4') requestId!: string;
  @ApiProperty({ enum: ['online', 'offline'] }) @IsIn(['online', 'offline']) format!: 'online' | 'offline';
  @ApiPropertyOptional({ maxLength: 2048 }) @ValidateIf(optional) @Transform(trim) @IsString() @Length(1, 2048) onlineUrl?: string;
  @ApiPropertyOptional({ maxLength: 500 }) @ValidateIf(optional) @Transform(trim) @IsString() @Length(1, 500) locationText?: string;
  @ApiPropertyOptional({ maxLength: 2000 }) @ValidateIf(optional) @Transform(trim) @IsString() @MaxLength(2000) privateNotes?: string;
}
export class LessonVersionDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(2147483646) version!: number;
}
export class RescheduleLessonDto extends LessonTimeDto {
  @ApiProperty({ minLength: 3, maxLength: 1000 }) @Transform(trim) @IsString() @Length(3, 1000) reason!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(2147483646) version!: number;
}
export class CancelLessonDto extends LessonVersionDto {
  @ApiProperty({ enum: ['teacher_cancelled', 'student_cancelled'] }) @IsIn(['teacher_cancelled', 'student_cancelled']) status!: 'teacher_cancelled' | 'student_cancelled';
  @ApiProperty({ minLength: 3, maxLength: 1000 }) @Transform(trim) @IsString() @Length(3, 1000) reason!: string;
}
export class AttendanceDto extends LessonVersionDto {
  @ApiProperty({ enum: ['present', 'absent', 'excused'] }) @IsIn(['present', 'absent', 'excused']) status!: 'present' | 'absent' | 'excused';
  @ApiPropertyOptional({ maxLength: 1000 }) @ValidateIf(optional) @Transform(trim) @IsString() @MaxLength(1000) comment?: string;
  @ApiPropertyOptional({ minLength: 3, maxLength: 1000 }) @ValidateIf(optional) @Transform(trim) @IsString() @Length(3, 1000) correctionReason?: string;
}
export type LessonStatus = 'scheduled' | 'completed' | 'student_absent' | 'student_cancelled' | 'teacher_cancelled' | 'rescheduled';
export class LessonAttendanceView {
  @ApiProperty({ enum: ['present', 'absent', 'excused', 'cancelled'] }) status!: 'present' | 'absent' | 'excused' | 'cancelled';
  @ApiProperty({ format: 'date-time' }) markedAt!: string;
  @ApiPropertyOptional({ description: 'Only the owning teacher.' }) comment?: string;
}
export class LessonView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) enrollmentId!: string;
  @ApiProperty() studentName!: string;
  @ApiProperty() studentPublicId!: string;
  @ApiProperty() teacherName!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty() durationMin!: number;
  @ApiProperty({ enum: ['online', 'offline'] }) format!: 'online' | 'offline';
  @ApiPropertyOptional() onlineUrl?: string;
  @ApiPropertyOptional() locationText?: string;
  @ApiProperty({ enum: ['scheduled', 'completed', 'student_absent', 'student_cancelled', 'teacher_cancelled', 'rescheduled'] }) status!: LessonStatus;
  @ApiProperty() version!: number;
  @ApiPropertyOptional({ format: 'uuid' }) rescheduledFromId?: string;
  @ApiPropertyOptional({ format: 'date-time' }) rescheduledFromStartsAt?: string;
  @ApiPropertyOptional({ format: 'uuid' }) replacementId?: string;
  @ApiPropertyOptional({ format: 'date-time' }) replacementStartsAt?: string;
  @ApiPropertyOptional({ description: 'Only the owning teacher.' }) privateNotes?: string;
  @ApiPropertyOptional({ type: LessonAttendanceView }) attendance?: LessonAttendanceView;
}
export class LessonPage {
  @ApiProperty({ type: [LessonView] }) items!: LessonView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class LessonMutationView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() status!: LessonStatus;
  @ApiProperty() version!: number;
  @ApiPropertyOptional({ format: 'uuid' }) rescheduledFromId?: string;
}
export class LessonHistoryView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['created', 'rescheduled', 'cancelled', 'attendance_marked', 'attendance_corrected'] }) type!: 'created' | 'rescheduled' | 'cancelled' | 'attendance_marked' | 'attendance_corrected';
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiPropertyOptional({ format: 'date-time' }) fromStartsAt?: string;
  @ApiPropertyOptional({ format: 'date-time' }) toStartsAt?: string;
  @ApiPropertyOptional() fromStatus?: string;
  @ApiPropertyOptional() toStatus?: string;
  @ApiPropertyOptional() fromAttendance?: string;
  @ApiPropertyOptional() toAttendance?: string;
  @ApiPropertyOptional() reason?: string;
  @ApiPropertyOptional() comment?: string;
}
export class LessonHistoryPage {
  @ApiProperty({ type: [LessonHistoryView] }) items!: LessonHistoryView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
