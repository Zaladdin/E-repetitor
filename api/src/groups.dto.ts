import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsObject, IsString, IsUUID, Length, Matches, Max, Min, Validate, ValidateNested, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import { ConnectionPageDto } from './connections.dto';
import { isOffsetDateTime } from './lessons.dto';

@ValidatorConstraint({ name: 'groupDateTime' })
class GroupDateTime implements ValidatorConstraintInterface {
  validate(value: unknown) { return isOffsetDateTime(value); }
  defaultMessage() { return 'Укажите существующую дату и время с часовым поясом.'; }
}
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.normalize('NFC').trim() : value;

export class GroupSlotDto {
  @ApiProperty({ minimum: 1, maximum: 7, description: 'ISO weekday: Monday is 1.' }) @IsInt() @Min(1) @Max(7) weekday!: number;
  @ApiProperty({ example: '16:00' }) @IsString() @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/) startTime!: string;
  @ApiProperty({ example: '17:30' }) @IsString() @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/) endTime!: string;
}
export class GroupInputDto {
  @ApiProperty({ minLength: 1, maxLength: 100 }) @Transform(trim) @IsString() @Length(1, 100) name!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') subjectId!: string;
  @ApiProperty({ example: 'Asia/Baku' }) @Transform(trim) @IsString() @Length(1, 100) timezone!: string;
  @ApiProperty({ type: [String], minItems: 1, maxItems: 50 }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ArrayUnique() @IsUUID('4', { each: true }) enrollmentIds!: string[];
  @ApiProperty({ type: [GroupSlotDto], minItems: 1, maxItems: 14 }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(14) @IsObject({ each: true }) @ValidateNested({ each: true }) @Type(() => GroupSlotDto) slots!: GroupSlotDto[];
}
export class CreateGroupDto extends GroupInputDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') requestId!: string;
}
export class UpdateGroupDto extends GroupInputDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(2147483646) version!: number;
}
export class ArchiveGroupDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(2147483646) version!: number;
}
export class GroupsQueryDto extends ConnectionPageDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 }) limit = 20;
}
export class GroupCandidatesQueryDto extends ConnectionPageDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') subjectId!: string;
}
export class GroupScheduleQueryDto extends ConnectionPageDto {
  @ApiProperty({ enum: ['teacher', 'student', 'parent'] }) @IsIn(['teacher', 'student', 'parent']) role!: 'teacher' | 'student' | 'parent';
  @ApiProperty({ format: 'date-time' }) @Validate(GroupDateTime) from!: string;
  @ApiProperty({ format: 'date-time' }) @Validate(GroupDateTime) to!: string;
}
export class GroupCandidateView {
  @ApiProperty({ format: 'uuid' }) enrollmentId!: string;
  @ApiProperty() studentName!: string;
  @ApiProperty() studentPublicId!: string;
}
export class GroupMemberView extends GroupCandidateView {
  @ApiProperty() status!: string;
}
export class GroupView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ format: 'uuid' }) subjectId!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: ['active', 'archived'] }) status!: 'active' | 'archived';
  @ApiProperty({ type: [GroupMemberView] }) members!: GroupMemberView[];
  @ApiProperty({ type: [GroupSlotDto] }) slots!: GroupSlotDto[];
}
export class GroupsPage {
  @ApiProperty({ type: [GroupView] }) items!: GroupView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class GroupCandidatesPage {
  @ApiProperty({ type: [GroupCandidateView] }) items!: GroupCandidateView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class GroupOccurrenceView {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'uuid' }) groupId!: string;
  @ApiProperty() groupName!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty() teacherName!: string;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty() timezone!: string;
  @ApiPropertyOptional({ description: 'Only the parent projection identifies their own child.' }) studentName?: string;
}
export class GroupSchedulePage {
  @ApiProperty({ type: [GroupOccurrenceView] }) items!: GroupOccurrenceView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
