import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { Course, CourseCategory, CourseCategoryTreeNode } from '@lms/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiJson } from '@/lib/api';

/** Category tree + course list (P2). Creation forms are shown to everyone but the API enforces the capabilities server-side. */
export function CoursesPage() {
  const [tree, setTree] = useState<CourseCategoryTreeNode[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [catName, setCatName] = useState('');
  const [catParent, setCatParent] = useState('0');
  const [courseName, setCourseName] = useState('');
  const [courseShort, setCourseShort] = useState('');
  const [courseCategory, setCourseCategory] = useState('');

  const reload = useCallback(async () => {
    const [t, c] = await Promise.all([
      apiJson<CourseCategoryTreeNode[]>('/api/v1/courses/categories/tree'),
      apiJson<Course[]>('/api/v1/courses'),
    ]);
    setTree(t);
    setCourses(c);
    if (c.length === 0 && t.length > 0) setCourseCategory(String(t[0]!.id));
  }, []);

  useEffect(() => { void reload().catch(() => setMessage('Could not load courses')); }, [reload]);

  const flatCategories: CourseCategory[] = [];
  const walk = (nodes: CourseCategoryTreeNode[]) => { for (const n of nodes) { flatCategories.push(n); walk(n.children); } };
  walk(tree);

  function renderTree(nodes: CourseCategoryTreeNode[]) {
    return (
      <ul className="ml-4 list-disc">
        {nodes.map((node) => (
          <li key={node.id}>
            <span>{node.name}</span>
            <ul className="ml-3">
              {courses.filter((c) => c.category === node.id).map((c) => (
                <li key={c.id}>
                  <Link to={`/courses/${c.id}`}>{c.fullname} ({c.shortname})</Link>
                  {!c.visible && <span> — hidden</span>}
                </li>
              ))}
            </ul>
            {node.children.length > 0 && renderTree(node.children)}
          </li>
        ))}
      </ul>
    );
  }

  async function createCategory(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await apiJson('/api/v1/courses/categories', {
        method: 'POST',
        body: JSON.stringify({ name: catName, parent: Number(catParent) || 0 }),
      });
      setCatName('');
      await reload();
      setMessage('Category created');
    } catch { setMessage('Could not create category (permission or validation error)'); }
  }

  async function createCourse(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await apiJson('/api/v1/courses', {
        method: 'POST',
        body: JSON.stringify({ fullname: courseName, shortname: courseShort, category: Number(courseCategory) }),
      });
      setCourseName(''); setCourseShort('');
      await reload();
      setMessage('Course created');
    } catch { setMessage('Could not create course (permission, duplicate shortname or validation error)'); }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <Card>
        <CardHeader>
          <CardTitle>Course categories</CardTitle>
          <CardDescription>Category tree with the courses in each category.</CardDescription>
        </CardHeader>
        <CardContent>
          {tree.length === 0 ? <p>No categories yet.</p> : renderTree(tree)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Create category</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={createCategory} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="cat-name">Category name</Label>
              <Input id="cat-name" value={catName} onChange={(e) => setCatName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cat-parent">Parent category</Label>
              <select id="cat-parent" value={catParent} onChange={(e) => setCatParent(e.target.value)} className="border px-2 py-1">
                <option value="0">Top level</option>
                {flatCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <Button type="submit">Create category</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Create course</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={createCourse} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="course-fullname">Course full name</Label>
              <Input id="course-fullname" value={courseName} onChange={(e) => setCourseName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="course-shortname">Course short name</Label>
              <Input id="course-shortname" value={courseShort} onChange={(e) => setCourseShort(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="course-category">Course category</Label>
              <select id="course-category" value={courseCategory} onChange={(e) => setCourseCategory(e.target.value)} className="border px-2 py-1">
                {flatCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <Button type="submit">Create course</Button>
          </form>
          {message && <p role="status" className="pt-2 text-sm">{message}</p>}
        </CardContent>
      </Card>
    </main>
  );
}
