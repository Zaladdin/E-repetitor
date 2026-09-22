import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsUUID, ValidateIf } from 'class-validator';
import { Role } from './common';

export class OverviewQueryDto {
  @ApiProperty({ enum: ['teacher', 'student', 'parent'] }) @IsIn(['teacher', 'student', 'parent']) role!: Role;
  @ApiPropertyOptional({ format: 'uuid', description: 'Parent role only: one actively connected child. Omit for all children.' })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.toLowerCase() : value)
  @IsUUID('4') studentId?: string;
}
export class OverviewCounts {
  @ApiProperty() activeEnrollments!: number;
  @ApiPropertyOptional({ description: 'Teacher only. Distinct active students in active enrollments.' }) activeStudents?: number;
  @ApiProperty() upcomingLessons!: number;
  @ApiProperty({ description: 'Noncancelled records without a teacher paid mark. Not a debt amount.' }) unmarkedPayments!: number;
  @ApiPropertyOptional({ description: 'Teacher only.' }) waitingReview?: number;
  @ApiPropertyOptional({ description: 'Teacher only.' }) readyToPublish?: number;
  @ApiPropertyOptional({ description: 'Student only. Assignments that can start a new attempt; excludes live attempts.' }) availableTests?: number;
  @ApiPropertyOptional({ description: 'Student only. Live attempts, including in closed enrollments.' }) inProgressTests?: number;
}
export class OverviewPaymentCounts {
  @ApiProperty() paid!: number;
  @ApiProperty() unpaid!: number;
}
export class OverviewAttendance {
  @ApiProperty() present!: number;
  @ApiProperty() absent!: number;
  @ApiProperty() excused!: number;
}
export class OverviewContext {
  @ApiProperty({ format: 'uuid' }) enrollmentId!: string;
  @ApiProperty() studentName!: string;
  @ApiProperty() studentPublicId!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty() teacherName!: string;
}
export class OverviewLessonTime {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty() durationMin!: number;
  @ApiProperty({ enum: ['online', 'offline'] }) format!: 'online' | 'offline';
}
export class OverviewLesson extends OverviewContext {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty() durationMin!: number;
  @ApiProperty({ enum: ['online', 'offline'] }) format!: 'online' | 'offline';
}
export class OverviewResultValue {
  @ApiProperty({ format: 'uuid' }) attemptId!: string;
  @ApiProperty() title!: string;
  @ApiProperty() score!: number;
  @ApiProperty() maxPoints!: number;
  @ApiProperty() percentage!: number;
  @ApiProperty({ format: 'date-time' }) publishedAt!: string;
}
export class OverviewResult extends OverviewContext {
  @ApiProperty({ format: 'uuid' }) attemptId!: string;
  @ApiProperty({ format: 'uuid' }) assignmentId!: string;
  @ApiProperty() title!: string;
  @ApiProperty() score!: number;
  @ApiProperty() maxPoints!: number;
  @ApiProperty() percentage!: number;
  @ApiProperty({ format: 'date-time' }) publishedAt!: string;
}
export class OverviewTestAction extends OverviewContext {
  @ApiProperty({ format: 'uuid' }) assignmentId!: string;
  @ApiPropertyOptional({ format: 'uuid' }) attemptId?: string;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: ['review', 'publish', 'continue', 'start'] }) action!: 'review' | 'publish' | 'continue' | 'start';
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) dueAt!: string | null;
}
export class OverviewSubject extends OverviewContext {
  @ApiProperty({ type: OverviewLessonTime, nullable: true }) nextLesson!: OverviewLessonTime | null;
  @ApiProperty({ type: OverviewResultValue, nullable: true }) latestResult!: OverviewResultValue | null;
  @ApiProperty({ type: OverviewPaymentCounts }) payment!: OverviewPaymentCounts;
  @ApiProperty({ type: OverviewAttendance }) attendance!: OverviewAttendance;
}
export class OverviewLessonPreview {
  @ApiProperty() total!: number;
  @ApiProperty({ type: [OverviewLesson], maxItems: 5 }) items!: OverviewLesson[];
}
export class OverviewResultPreview {
  @ApiProperty() total!: number;
  @ApiProperty({ type: [OverviewResult], maxItems: 5 }) items!: OverviewResult[];
}
export class OverviewTestPreview {
  @ApiProperty() total!: number;
  @ApiProperty({ type: [OverviewTestAction], maxItems: 5 }) items!: OverviewTestAction[];
}
export class OverviewSubjectPreview {
  @ApiProperty() total!: number;
  @ApiProperty({ type: [OverviewSubject], maxItems: 20 }) items!: OverviewSubject[];
}
export class OverviewView {
  @ApiProperty({ enum: ['teacher', 'student', 'parent'] }) role!: Role;
  @ApiProperty({ format: 'date-time' }) asOf!: string;
  @ApiProperty({ format: 'date-time' }) lessonUntil!: string;
  @ApiProperty({ format: 'date-time' }) attendanceSince!: string;
  @ApiPropertyOptional({ format: 'uuid' }) selectedStudentId?: string;
  @ApiProperty({ type: OverviewCounts }) counts!: OverviewCounts;
  @ApiProperty({ type: OverviewPaymentCounts }) payments!: OverviewPaymentCounts;
  @ApiProperty({ type: OverviewLessonPreview }) upcomingLessons!: OverviewLessonPreview;
  @ApiPropertyOptional({ type: OverviewTestPreview, description: 'Teacher/student only. No unpublished test information for parents.' }) testAttention?: OverviewTestPreview;
  @ApiProperty({ type: OverviewResultPreview }) latestResults!: OverviewResultPreview;
  @ApiProperty({ type: OverviewSubjectPreview }) subjects!: OverviewSubjectPreview;
}
