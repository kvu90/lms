import { IsInt, IsOptional, IsString } from 'class-validator';

export class CreateEnrolInstanceDto {
  @IsString() method!: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() roleShortname?: string;
  @IsOptional() @IsInt() status?: number;
  @IsOptional() @IsInt() enrolperiod?: number;
  @IsOptional() @IsInt() cohortId?: number;
  @IsOptional() @IsInt() groupId?: number;
  @IsOptional() @IsString() onCohortLeave?: 'suspend' | 'unenrol';
}
export class UpdateEnrolInstanceDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsInt() status?: number;
  @IsOptional() @IsInt() enrolperiod?: number;
  @IsOptional() @IsString() onCohortLeave?: 'suspend' | 'unenrol';
  @IsOptional() @IsInt() groupId?: number;
}
export class EnrolUserDto {
  @IsInt() userid!: number;
  @IsOptional() @IsString() timestart?: string;
  @IsOptional() @IsString() timeend?: string;
}
