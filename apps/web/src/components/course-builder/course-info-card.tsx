import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { Link } from 'react-router';
import type { Course } from '@lms/contracts';
import { Button } from '@lms/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@lms/ui/components/card';
import { CardDescription } from '@lms/ui/components/card';
import { Input } from '@lms/ui/components/input';
import { Label } from '@lms/ui/components/label';
import { useTranslation } from 'react-i18next';

interface CourseInfoCardProps {
  course: Course | null;
  loadError: string | null;
  courseId: string;
  fullName: string;
  setFullname: Dispatch<SetStateAction<string>>;
  shortName: string;
  setShortname: Dispatch<SetStateAction<string>>;
  courseCategory: string;
  setCourseCategory: Dispatch<SetStateAction<string>>;
  summary: string;
  setSummary: Dispatch<SetStateAction<string>>;
  startDate: string;
  setStartdate: Dispatch<SetStateAction<string>>;
  endDate: string;
  setEnddate: Dispatch<SetStateAction<string>>;
  courseVisible: boolean;
  setCourseVisible: Dispatch<SetStateAction<boolean>>;
  isTemplate: boolean;
  setIsTemplate: Dispatch<SetStateAction<boolean>>;
  onSaveCourse: (event: FormEvent) => void;
  message: string | null;
}

/** Thẻ thông tin khoá học của trang Xây dựng khoá (form sửa thông tin + thông điệp). */
export function CourseInfoCard({
  course, loadError, courseId, fullName, setFullname, shortName, setShortname, courseCategory,
  setCourseCategory, summary, setSummary, startDate, setStartdate, endDate, setEnddate,
  courseVisible, setCourseVisible, isTemplate, setIsTemplate, onSaveCourse, message,
}: CourseInfoCardProps) {
  const { t } = useTranslation('app');
  const saveCourse = onSaveCourse;
  return (
      <Card>
        <CardHeader>
          <CardTitle>{t('courseBuilder')}</CardTitle>
          <CardDescription>{t('courseBuilderDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          {loadError ? <p role="alert">{loadError}</p> : null}
          {course ? (
            <form onSubmit={(e) => void saveCourse(e)} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="builder-fullname">{t('courseFullName')}</Label>
                <Input id="builder-fullname" value={fullName} onChange={(e) => setFullname(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="builder-shortname">{t('courseShortName')}</Label>
                <Input id="builder-shortname" value={shortName} onChange={(e) => setShortname(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="builder-category">{t('courseCategory')}</Label>
                <Input id="builder-category" value={courseCategory} onChange={(e) => setCourseCategory(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="builder-summary">{t('courseSummary')}</Label>
                <Input id="builder-summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="builder-startdate">{t('courseStartDate')}</Label>
                <Input id="builder-startdate" type="date" value={startDate} onChange={(e) => setStartdate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="builder-enddate">{t('courseEndDate')}</Label>
                <Input id="builder-enddate" type="date" value={endDate} onChange={(e) => setEnddate(e.target.value)} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={courseVisible} onChange={(e) => setCourseVisible(e.target.checked)} />
                {t('courseVisible')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={isTemplate} onChange={(e) => setIsTemplate(e.target.checked)} />
                {t('builderIsTemplate')}
              </label>
              <div className="flex gap-2">
                <Button type="submit">{t('saveCourse')}</Button>
                <Link className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-4 text-sm font-medium" to={`/courses/${courseId}/admin`}>{t('builderToAdmin')}</Link>
              </div>
            </form>
          ) : null}
          {message ? (
            <p role="status" className="pt-2 text-sm">
              {message}
            </p>
          ) : null}
        </CardContent>
      </Card>
  );
}
