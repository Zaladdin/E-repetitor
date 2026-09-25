import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsNumber, IsObject, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { ConnectionPageDto } from './connections.dto';

const optional = (_object: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.normalize('NFC').trim() : value;
export type TestStatus = 'draft' | 'published' | 'archived';
export type AttemptStatus = 'started' | 'submitted' | 'waiting_review' | 'completed' | 'published' | 'expired' | 'abandoned';
export type AnswerPolicy = 'never' | 'after_submission' | 'after_deadline' | 'after_teacher_publish';
export type ResultPolicy = 'after_submission' | 'after_teacher_publish';
export type ResultVisibility = 'visible' | 'pending_review' | 'pending_publication' | 'unavailable';
export class QuestionOption {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') id!: string;
  @ApiProperty({ maxLength: 300 }) @IsString() @MaxLength(300) text!: string;
}
export class Question {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') id!: string;
  @ApiProperty({ enum: ['single_choice', 'multiple_choice', 'text'] }) @IsIn(['single_choice', 'multiple_choice', 'text']) type!: 'single_choice' | 'multiple_choice' | 'text';
  @ApiProperty({ maxLength: 1000 }) @IsString() @MaxLength(1000) prompt!: string;
  @ApiProperty({ minimum: 1, maximum: 100 }) @IsInt() @Min(1) @Max(100) points!: number;
  @ApiProperty({ type: [QuestionOption], maxItems: 8 }) @IsArray() @ArrayMaxSize(8) @IsObject({ each: true }) @ValidateNested({ each: true }) @Type(() => QuestionOption) options!: QuestionOption[];
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(8) @ArrayUnique() @IsUUID('4', { each: true }) correctOptionIds!: string[];
  @ApiPropertyOptional({ maxLength: 1000 }) @ValidateIf(optional) @IsString() @MaxLength(1000) explanation?: string;
}
export class TestDraftDto {
  @ApiProperty({ minLength: 1, maxLength: 200 }) @Transform(trim) @IsString() @Length(1, 200) title!: string;
  @ApiPropertyOptional({ maxLength: 4000 }) @ValidateIf(optional) @IsString() @MaxLength(4000) instruction?: string;
  @ApiPropertyOptional({ maxLength: 200 }) @ValidateIf(optional) @Transform(trim) @IsString() @MaxLength(200) topic?: string;
  @ApiPropertyOptional({ minimum: 0, maximum: 3000 }) @ValidateIf(optional) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(3000) passPoints?: number;
  @ApiProperty({ type: [Question], maxItems: 30 }) @IsArray() @ArrayMaxSize(30) @IsObject({ each: true }) @ValidateNested({ each: true }) @Type(() => Question) questions!: Question[];
}
export class CreateTestDto extends TestDraftDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') requestId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') subjectId!: string;
}
export class UpdateTestDto extends TestDraftDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(2147483646) revision!: number;
}
export class TestRevisionDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(2147483646) revision!: number;
}
export class CreateTestVariantDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') requestId!: string;
  @ApiProperty({ pattern: '^[A-Z]$' }) @IsString() @Matches(/^[A-Z]$/) variantCode!: string;
}
export class CreateAssignmentDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') requestId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') versionId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') enrollmentId!: string;
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 10 }) @IsInt() @Min(1) @Max(10) maxAttempts = 1;
  @ApiPropertyOptional({ minimum: 1, maximum: 180 }) @ValidateIf(optional) @IsInt() @Min(1) @Max(180) timeLimitMin?: number;
  @ApiPropertyOptional({ format: 'date-time' }) @ValidateIf(optional) @IsString() @MaxLength(40) dueAt?: string;
  @ApiPropertyOptional({ enum: ['never', 'after_submission', 'after_deadline', 'after_teacher_publish'], default: 'never' }) @IsIn(['never', 'after_submission', 'after_deadline', 'after_teacher_publish']) answerPolicy: AnswerPolicy = 'never';
  @ApiPropertyOptional({ enum: ['after_submission', 'after_teacher_publish'], default: 'after_teacher_publish' }) @IsIn(['after_submission', 'after_teacher_publish']) resultPolicy: ResultPolicy = 'after_teacher_publish';
}
export class CreateGroupAssignmentDto extends OmitType(CreateAssignmentDto, ['enrollmentId'] as const) {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') groupId!: string;
}
export class AssignmentQueryDto extends ConnectionPageDto {
  @ApiProperty({ enum: ['teacher', 'student', 'parent'] }) @IsIn(['teacher', 'student', 'parent']) role!: 'teacher' | 'student' | 'parent';
  @ApiPropertyOptional({ format: 'uuid' }) @ValidateIf(optional) @IsUUID('4') testId?: string;
}
export class AttemptQueryDto {
  @ApiProperty({ enum: ['teacher', 'student', 'parent'] }) @IsIn(['teacher', 'student', 'parent']) role!: 'teacher' | 'student' | 'parent';
}
export class StartAttemptDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') requestId!: string;
}
export class AttemptVersionDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(2147483646) version!: number;
}
export class Answer {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') questionId!: string;
  @ApiPropertyOptional({ type: [String] }) @ValidateIf(optional) @IsArray() @ArrayMaxSize(8) @ArrayUnique() @IsUUID('4', { each: true }) selectedOptionIds?: string[];
  @ApiPropertyOptional({ maxLength: 4000 }) @ValidateIf(optional) @IsString() @MaxLength(4000) text?: string;
}
export class SaveAnswersDto extends AttemptVersionDto {
  @ApiProperty({ type: [Answer], maxItems: 30 }) @IsArray() @ArrayMaxSize(30) @IsObject({ each: true }) @ValidateNested({ each: true }) @Type(() => Answer) answers!: Answer[];
}
export class Grade {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') questionId!: string;
  @ApiProperty({ minimum: 0, maximum: 100 }) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) points!: number;
  @ApiPropertyOptional({ maxLength: 1000 }) @ValidateIf(optional) @IsString() @MaxLength(1000) comment?: string;
}
export class ReviewAttemptDto extends AttemptVersionDto {
  @ApiProperty({ type: [Grade], maxItems: 30 }) @IsArray() @ArrayMaxSize(30) @IsObject({ each: true }) @ValidateNested({ each: true }) @Type(() => Grade) grades!: Grade[];
  @ApiPropertyOptional({ maxLength: 2000 }) @ValidateIf(optional) @IsString() @MaxLength(2000) comment?: string;
}
export class TestVersionSummary {
  @ApiProperty() id!: string;
  @ApiProperty() testId!: string;
  @ApiProperty() familyId!: string;
  @ApiProperty() variantCode!: string;
  @ApiProperty() number!: number;
  @ApiProperty() title!: string;
  @ApiProperty() maxPoints!: number;
  @ApiPropertyOptional() passPoints?: number;
  @ApiProperty() publishedAt!: string;
}
export class LatestTestVersionView {
  @ApiProperty() id!: string;
  @ApiProperty() number!: number;
  @ApiProperty() publishedAt!: string;
}
export class TestSummary {
  @ApiProperty() id!: string;
  @ApiProperty() familyId!: string;
  @ApiProperty() variantCode!: string;
  @ApiProperty() subjectId!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty() title!: string;
  @ApiPropertyOptional() topic?: string;
  @ApiPropertyOptional() passPoints?: number;
  @ApiProperty({ enum: ['draft', 'published', 'archived'] }) status!: TestStatus;
  @ApiProperty() revision!: number;
  @ApiProperty() questionCount!: number;
  @ApiProperty() maxPoints!: number;
  @ApiPropertyOptional({ type: LatestTestVersionView }) latestVersion?: LatestTestVersionView;
  @ApiProperty() updatedAt!: string;
}
export class TestDetail extends TestSummary {
  @ApiProperty() instruction!: string;
  @ApiProperty({ type: [Question] }) questions!: Question[];
}
export class TestVersion extends TestVersionSummary {
  @ApiProperty() subjectId!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty() instruction!: string;
  @ApiPropertyOptional() topic?: string;
  @ApiProperty({ type: [Question] }) questions!: Question[];
}
export class TestPage {
  @ApiProperty({ type: [TestSummary] }) items!: TestSummary[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class TestFamilyView {
  @ApiProperty() id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() subjectId!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty({ type: [TestSummary] }) variants!: TestSummary[];
}
export class TestFamilyPage {
  @ApiProperty({ type: [TestFamilyView] }) items!: TestFamilyView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class TestVersionPage {
  @ApiProperty({ type: [TestVersionSummary] }) items!: TestVersionSummary[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export class AttemptSummary {
  @ApiProperty() id!: string;
  @ApiProperty() number!: number;
  @ApiProperty({ enum: ['started', 'submitted', 'waiting_review', 'completed', 'published', 'expired', 'abandoned'] }) status!: AttemptStatus;
  @ApiProperty() version!: number;
  @ApiProperty() startedAt!: string;
  @ApiPropertyOptional() expiresAt?: string;
  @ApiPropertyOptional() submittedAt?: string;
  @ApiPropertyOptional() publishedAt?: string;
  @ApiPropertyOptional() score?: number;
  @ApiProperty() maxPoints!: number;
  @ApiProperty() totalQuestions!: number;
  @ApiPropertyOptional() correctAnswers?: number;
  @ApiProperty({ enum: ['visible', 'pending_review', 'pending_publication', 'unavailable'] }) resultVisibility!: ResultVisibility;
  @ApiPropertyOptional() passPoints?: number;
  @ApiPropertyOptional() passed?: boolean;
  @ApiPropertyOptional() percentage?: number;
  @ApiPropertyOptional() comment?: string;
}
export class AssignmentView {
  @ApiProperty() id!: string;
  @ApiProperty() testId!: string;
  @ApiProperty() familyId!: string;
  @ApiProperty() variantCode!: string;
  @ApiPropertyOptional() groupId?: string;
  @ApiPropertyOptional() groupName?: string;
  @ApiProperty() versionId!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty() title!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty() studentName!: string;
  @ApiProperty() studentPublicId!: string;
  @ApiProperty() teacherName!: string;
  @ApiProperty() enrollmentId!: string;
  @ApiProperty() maxAttempts!: number;
  @ApiPropertyOptional() timeLimitMin?: number;
  @ApiPropertyOptional() dueAt?: string;
  @ApiProperty() answerPolicy!: AnswerPolicy;
  @ApiProperty() resultPolicy!: ResultPolicy;
  @ApiProperty() createdAt!: string;
  @ApiProperty() isLate!: boolean;
  @ApiProperty({ type: [AttemptSummary] }) attempts!: AttemptSummary[];
}
export class GroupAssignmentView {
  @ApiProperty({ type: [AssignmentView] }) items!: AssignmentView[];
  @ApiProperty() total!: number;
  @ApiProperty() groupId!: string;
  @ApiProperty() groupName!: string;
}
export class AssignmentPage {
  @ApiProperty({ type: [AssignmentView] }) items!: AssignmentView[];
  @ApiProperty() total!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() offset!: number;
}
export type PublicQuestion = Omit<Question, 'correctOptionIds' | 'explanation'> & Partial<Pick<Question, 'correctOptionIds' | 'explanation'>>;
export class PublicQuestionView extends OmitType(Question, ['correctOptionIds', 'explanation'] as const) {
  @ApiPropertyOptional({ type: [String], description: 'Teacher or student after answer-policy release only.' }) correctOptionIds?: string[];
  @ApiPropertyOptional() explanation?: string;
}
export class AttemptView extends AttemptSummary {
  @ApiProperty() assignmentId!: string;
  @ApiProperty() title!: string;
  @ApiProperty() instruction!: string;
  @ApiPropertyOptional() topic?: string;
  @ApiProperty() studentName!: string;
  @ApiProperty() subjectName!: string;
  @ApiProperty() teacherName!: string;
  @ApiProperty() answerPolicy!: AnswerPolicy;
  @ApiProperty() resultPolicy!: ResultPolicy;
  @ApiProperty() serverNow!: string;
  @ApiPropertyOptional({ type: [PublicQuestionView], description: 'Absent for parents. Correct keys and explanations withheld from students until answer policy permits.' }) questions?: PublicQuestion[];
  @ApiPropertyOptional({ type: [Answer] }) answers?: Answer[];
  @ApiPropertyOptional({ type: [Grade], description: 'Student: final results released by resultPolicy. Never returned to parents.' }) grades?: Grade[];
}
export class AttemptMutationView {
  @ApiProperty() id!: string;
  @ApiProperty() status!: AttemptStatus;
  @ApiProperty() version!: number;
  @ApiPropertyOptional() serverNow?: string;
  @ApiPropertyOptional() expiresAt?: string;
}
