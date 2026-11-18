import { afterNextRender, Component, computed, ElementRef, inject, Injector, signal, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Api } from './api';
import { AttentionReason, AttentionTask, Comment, Context, Project, Task, TaskDetail, TaskStatus } from './models';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
})
export class AppComponent {
  api = inject(Api);
  context = signal<Context | null>(null);
  projects = signal<Project[]>([]);
  project = signal<Project | null>(null);
  tasks = signal<Task[]>([]);
  attention = signal<AttentionTask[]>([]);
  attentionError = signal('');
  managedProjects = computed(() => this.projects().filter(p => !p.archived && p.owner_id === this.context()?.user.id));
  detail = signal<TaskDetail | null>(null);
  drawerProject = computed(() => {
    const detail = this.detail();
    return detail ? this.projects().find(p => p.id === detail.project_id) : this.project();
  });
  loading = signal(false);
  saving = signal(false);
  error = signal('');
  notice = signal('');
  status = '';
  search = '';
  comment = '';
  creating = signal(false);
  draft = this.emptyDraft();
  private generation = 0;
  private attentionGeneration = 0;
  private detailGeneration = 0;
  private injector = inject(Injector);
  private drawerClose = viewChild<ElementRef<HTMLButtonElement>>('drawerClose');
  readonly reasonLabels: Record<AttentionReason, string> = {
    blocked: 'Заблокирована', overdue: 'Просрочена', due_soon: 'Срок в ближайшие 24 ч', unassigned: 'Нет исполнителя',
  };
  readonly statuses: { value: TaskStatus; label: string }[] = [
    { value: 'open', label: 'Открыта' }, { value: 'in_progress', label: 'В работе' },
    { value: 'blocked', label: 'Заблокирована' }, { value: 'done', label: 'Готово' },
  ];

  constructor() { void this.load(); }

  async load(): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.error.set('');
    this.closeDetail();
    try {
      const [context, projects] = await Promise.all([
        this.api.request<Context>('/context'), this.api.request<Project[]>('/projects'),
      ]);
      if (generation !== this.generation) return;
      this.context.set(context);
      this.projects.set(projects);
      if (this.managedProjects().length) {
        await this.selectAttention();
      } else if (projects[0]) {
        await this.selectProject(projects[0]);
      }
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  switchUser(value: string): void {
    this.api.userId = Number(value);
    this.project.set(null);
    this.projects.set([]);
    this.tasks.set([]);
    this.attention.set([]);
    this.attentionError.set('');
    this.context.set(null);
    this.notice.set('');
    void this.load();
  }

  async selectAttention(): Promise<void> {
    ++this.generation;
    this.project.set(null);
    this.error.set('');
    this.notice.set('');
    this.closeDetail();
    await this.refreshAttention();
  }

  async refreshAttention(): Promise<void> {
    const generation = this.generation;
    const request = ++this.attentionGeneration;
    this.loading.set(true);
    this.attentionError.set('');
    try {
      const tasks = await this.api.request<AttentionTask[]>('/attention');
      if (generation === this.generation && request === this.attentionGeneration) this.attention.set(tasks);
    } catch (error) {
      if (generation === this.generation && request === this.attentionGeneration) {
        this.attentionError.set(error instanceof Error ? error.message : 'Не удалось загрузить задачи');
      }
    } finally {
      if (generation === this.generation && request === this.attentionGeneration) this.loading.set(false);
    }
  }

  async selectProject(project: Project): Promise<void> {
    const generation = ++this.generation;
    this.loading.set(true);
    this.error.set('');
    this.notice.set('');
    this.project.set(project);
    this.tasks.set([]);
    this.status = '';
    this.search = '';
    this.closeDetail();
    try {
      const tasks = await this.api.request<Task[]>(`/projects/${project.id}/tasks`);
      if (generation === this.generation) this.tasks.set(tasks);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  filteredTasks(): Task[] {
    return this.tasks().filter(task => (!this.status || task.status === this.status)
      && task.title.toLocaleLowerCase('ru').includes(this.search.toLocaleLowerCase('ru')));
  }

  async openTask(task: Pick<Task, 'id'>): Promise<void> {
    const generation = ++this.detailGeneration;
    this.error.set('');
    this.notice.set('');
    this.creating.set(false);
    this.detail.set(null);
    try {
      const detail = await this.api.request<TaskDetail>(`/tasks/${task.id}`);
      if (generation !== this.detailGeneration) return;
      this.detail.set(detail);
      this.comment = '';
      this.draft = {
        title: detail.title, description: detail.description, status: detail.status,
        assignee_id: detail.assignee_id,
        due_at: detail.due_at ? detail.due_at.slice(0, 16) : '',
      };
      this.focusDrawer();
    } catch (error) {
      if (generation === this.detailGeneration) this.fail(error);
    }
  }

  closeDetail(): void {
    ++this.detailGeneration;
    this.detail.set(null);
    this.creating.set(false);
    this.comment = '';
  }

  createTask(): void {
    this.closeDetail();
    this.draft = this.emptyDraft();
    this.creating.set(true);
    this.focusDrawer();
  }

  async saveTask(): Promise<void> {
    const project = this.drawerProject();
    if (!project || project.archived || this.saving()) return;
    const userId = this.api.userId;
    const generation = this.detailGeneration;
    const existing = this.detail();
    this.saving.set(true);
    this.error.set('');
    try {
      const data = {
        ...this.draft,
        due_at: this.draft.due_at ? `${this.draft.due_at}:00Z` : null,
        ...(existing ? { version: existing.version } : {}),
      };
      const task = await this.api.request<Task>(existing ? `/tasks/${existing.id}` : `/projects/${project.id}/tasks`, existing ? 'PATCH' : 'POST', data);
      if (userId !== this.api.userId) return;
      if (!existing) this.projects.update(list => list.map(p => p.id === project.id ? { ...p, task_count: p.task_count + 1 } : p));
      if (this.project()?.id === project.id) {
        this.tasks.update(list => existing ? list.map(t => t.id === task.id ? task : t) : [...list, task]);
      }
      if (generation === this.detailGeneration) {
        // Saving fields must not erase a comment the user has not sent yet.
        this.detail.set({ ...task, comments: existing?.comments ?? [] });
        this.creating.set(false);
        this.draft = {
          title: task.title, description: task.description, status: task.status,
          assignee_id: task.assignee_id, due_at: task.due_at?.slice(0, 16) ?? '',
        };
        this.notice.set('Задача сохранена');
      }
      if (!this.project() && this.managedProjects().length) void this.refreshAttention();
    } catch (error) { if (generation === this.detailGeneration) this.fail(error); }
    finally { this.saving.set(false); }
  }

  async addComment(): Promise<void> {
    const task = this.detail();
    if (!task || this.drawerProject()?.archived || this.saving()) return;
    const userId = this.api.userId;
    const generation = this.detailGeneration;
    this.saving.set(true);
    this.error.set('');
    try {
      const comment = await this.api.request<Comment>(`/tasks/${task.id}/comments`, 'POST', { body: this.comment });
      if (generation === this.detailGeneration) {
        // Refresh only the discussion: fields may contain unsaved user edits.
        this.detail.update(current => current ? { ...current, comments: [...current.comments, comment] } : current);
        this.comment = '';
        this.notice.set('Комментарий добавлен');
      }
      if (userId === this.api.userId && !this.project() && this.managedProjects().length) void this.refreshAttention();
    } catch (error) { if (generation === this.detailGeneration) this.fail(error); }
    finally { this.saving.set(false); }
  }

  statusLabel(status: string): string { return this.statuses.find(s => s.value === status)?.label ?? status; }
  userName(id: number | null): string { return this.context()?.users.find(u => u.id === id)?.name ?? 'Не назначен'; }
  projectName(id: number): string { return this.projects().find(p => p.id === id)?.name ?? ''; }
  private focusDrawer(): void {
    afterNextRender(() => this.drawerClose()?.nativeElement.focus(), { injector: this.injector });
  }
  private fail(error: unknown): void { this.error.set(error instanceof Error ? error.message : 'Не удалось выполнить запрос'); }
  private emptyDraft(): { title: string; description: string; status: TaskStatus; assignee_id: number | null; due_at: string } {
    return { title: '', description: '', status: 'open', assignee_id: null, due_at: '' };
  }
}
