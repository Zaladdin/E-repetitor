import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, IsUUID, Matches, Max, Min } from 'class-validator';

export class StudentIdDto {
  @ApiProperty({ example: 'STU-K7M4-P92X', pattern: '^STU-[A-Z0-9]{4}-[A-Z0-9]{4}$' })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString() @Matches(/^STU-[A-Z0-9]{4}-[A-Z0-9]{4}$/, { message: 'Введите Student ID в формате STU-K7M4-P92X.' })
  publicId!: string;
}
export class EnrollmentRequestDto extends StudentIdDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') subjectId!: string;
}
export class EnrollmentStatusDto {
  @ApiProperty({ enum: ['active', 'paused', 'completed', 'cancelled'] })
  @IsIn(['active', 'paused', 'completed', 'cancelled']) status!: 'active' | 'paused' | 'completed' | 'cancelled';
}
const queryInteger = ({ value }: { value: unknown }) => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
export class ConnectionPageDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @Transform(queryInteger) @IsInt() @Min(1) @Max(100) limit = 50;
  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 10000 })
  @Transform(queryInteger) @IsInt() @Min(0) @Max(10000) offset = 0;
}
export class EnrollmentQueryDto extends ConnectionPageDto {
  @ApiProperty({ enum: ['teacher', 'student'] }) @IsIn(['teacher', 'student']) role!: 'teacher' | 'student';
}
export class ParentConnectionQueryDto extends ConnectionPageDto {
  @ApiProperty({ enum: ['parent', 'student'] }) @IsIn(['parent', 'student']) role!: 'parent' | 'student';
}

export type EnrollmentStatus = 'pending' | 'active' | 'rejected' | 'expired' | 'paused' | 'completed' | 'cancelled';
export type ParentConnectionStatus = 'pending' | 'active' | 'rejected' | 'revoked';
export class EnrollmentView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() studentPublicId!: string;
  @ApiPropertyOptional({ description: 'Only the owning teacher after student acceptance.' }) studentName?: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty() teacherName!: string;
  @ApiProperty({ enum: ['pending', 'active', 'rejected', 'expired', 'paused', 'completed', 'cancelled'] }) status!: EnrollmentStatus;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class ParentConnectionView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() studentPublicId!: string;
  @ApiPropertyOptional({ description: 'Only an active connection in the parent context.' }) studentName?: string;
  @ApiPropertyOptional({ description: 'Only the owning student context.' }) parentName?: string;
  @ApiProperty({ enum: ['pending', 'active', 'rejected', 'revoked'] }) status!: ParentConnectionStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class ChildEnrollmentView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty() teacherName!: string;
  @ApiProperty({ enum: ['active'] }) status!: 'active';
}
export class ParentChildView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() publicId!: string;
  @ApiProperty({ type: [ChildEnrollmentView] }) enrollments!: ChildEnrollmentView[];
}
export class EnrollmentPage {
  @ApiProperty({ type: [EnrollmentView] }) items!: EnrollmentView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class ParentConnectionPage {
  @ApiProperty({ type: [ParentConnectionView] }) items!: ParentConnectionView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class ParentChildrenPage {
  @ApiProperty({ type: [ParentChildView] }) items!: ParentChildView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class ConnectionMutationView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['pending','active','rejected','expired','paused','completed','cancelled','revoked'] })
  status!: EnrollmentStatus | ParentConnectionStatus;
}
