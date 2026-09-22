import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, IsUUID, Length, Matches, Max, Min, ValidateIf } from 'class-validator';
import type { Role } from './common';

export const USER_STATUSES = ['pending_verification', 'active', 'suspended', 'deactivated', 'deleted'] as const;
export type UserStatus = typeof USER_STATUSES[number];
const optional = (_object: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.normalize('NFC').trim() : value;
const integer = ({ value }: { value: unknown }) => typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

export class AdminPageDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 }) @Transform(integer) @IsInt() @Min(1) @Max(100) limit = 20;
  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 10000 }) @Transform(integer) @IsInt() @Min(0) @Max(10000) offset = 0;
}
export class AdminUsersQueryDto extends AdminPageDto {
  @ApiPropertyOptional({ maxLength: 254, description: 'Literal case-insensitive email or public student ID substring.' })
  @ValidateIf(optional) @Transform(trim) @IsString() @Length(0, 254) query?: string;
  @ApiPropertyOptional({ enum: ['teacher', 'student', 'parent', 'admin'] })
  @ValidateIf(optional) @IsIn(['teacher', 'student', 'parent', 'admin']) role?: Role | 'admin';
  @ApiPropertyOptional({ enum: USER_STATUSES }) @ValidateIf(optional) @IsIn(USER_STATUSES) status?: UserStatus;
}
export class AdminAuditQueryDto extends AdminPageDto {
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(optional)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.toLowerCase() : value) @IsUUID('4') userId?: string;
}
export class AdminStatusDto {
  @ApiProperty({ enum: ['active', 'suspended', 'deactivated'] }) @IsIn(['active', 'suspended', 'deactivated']) status!: 'active' | 'suspended' | 'deactivated';
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ') : value) @IsString() @Length(3, 500)
  @Matches(/^[^\u0000-\u001F\u007F]+$/u, { message: 'Причина содержит недопустимые символы.' }) reason!: string;
  @ApiProperty({ minimum: 1, maximum: 2147483646 }) @IsInt() @Min(1) @Max(2147483646) version!: number;
}
export class AdminUserView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ enum: USER_STATUSES }) status!: UserStatus;
  @ApiProperty({ enum: ['teacher', 'student', 'parent'], isArray: true }) roles!: Role[];
  @ApiProperty() isAdmin!: boolean;
  @ApiProperty({ type: String, nullable: true }) publicId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() statusVersion!: number;
}
export class AdminUsersPage {
  @ApiProperty({ type: [AdminUserView] }) items!: AdminUserView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class AdminUserDetail {
  @ApiProperty({ type: AdminUserView }) user!: AdminUserView;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ description: 'Unexpired, unrevoked sessions. Tokens and device data are never returned.' }) activeSessions!: number;
}
export class AdminAuditView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() action!: string;
  @ApiProperty({ type: String, nullable: true }) actorId!: string | null;
  @ApiProperty({ type: String, nullable: true }) actorName!: string | null;
  @ApiProperty({ format: 'uuid' }) entityId!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, nullable: true }) fromStatus!: UserStatus | null;
  @ApiProperty({ type: String, nullable: true }) toStatus!: UserStatus | null;
}
export class AdminAuditPage {
  @ApiProperty({ type: [AdminAuditView] }) items!: AdminAuditView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
class AdminUserCounts {
  @ApiProperty() total!: number;
  @ApiProperty() active!: number;
  @ApiProperty() suspended!: number;
  @ApiProperty() pendingVerification!: number;
  @ApiProperty() deactivated!: number;
  @ApiProperty() deleted!: number;
}
class AdminEnrollmentCounts { @ApiProperty() total!: number; @ApiProperty() active!: number; }
class AdminLessonCounts { @ApiProperty() total!: number; @ApiProperty() scheduled!: number; }
class AdminTestCounts { @ApiProperty() total!: number; @ApiProperty() published!: number; }
export class AdminOverviewView {
  @ApiProperty({ type: AdminUserCounts }) users!: AdminUserCounts;
  @ApiProperty({ type: AdminEnrollmentCounts }) enrollments!: AdminEnrollmentCounts;
  @ApiProperty({ type: AdminLessonCounts }) lessons!: AdminLessonCounts;
  @ApiProperty({ type: AdminTestCounts }) tests!: AdminTestCounts;
  @ApiProperty({ format: 'date-time' }) generatedAt!: string;
}
