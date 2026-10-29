import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzStepsModule } from 'ng-zorro-antd/steps';
import { ElectronService } from '../../services/electron.service';
import { ProjectService } from '../../services/project.service';
import { ConfigService } from '../../services/config.service';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NpmService } from '../../services/npm.service';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { Router } from '@angular/router';
import { PlatformService } from '../../services/platform.service';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { CloudService } from '../../tools/cloud-space/services/cloud.service';
import { isSupportedRobotDevice } from '../../services/robot-device-catalog';
import { firstValueFrom, Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { createBoardSearchIndex, searchBoards } from '../../utils/fuzzy-search.utils';
import type { AnyOrama } from '@orama/orama';
import { NzMessageService } from 'ng-zorro-antd/message';

@Component({
  selector: 'app-project-new',
  imports: [
    CommonModule,
    FormsModule,
    NzToolTipModule,
    NzButtonModule,
    NzInputModule,
    NzStepsModule,
    NzSelectModule,
    NzTagModule,
    TranslateModule,
    NzRadioModule
  ],
  templateUrl: './project-new.component.html',
  styleUrl: './project-new.component.scss',
})
export class ProjectNewComponent implements OnDestroy {
  currentStep = 0;

  currentBoard: any = null;
  newProjectData: NewProjectData = {
    name: '',
    path: '',
    board: {
      name: '',
      nickname: '',
      version: '',
    },
    devmode: ''
  };

  boardVersion = '';

  // 搜索开发板关键字
  keyword = '';

  _boardList: any[] = [];
  boardList: any[] = [];

  private searchSubject = new Subject<string>();
  private destroy$ = new Subject<void>();
  private searchIndex: AnyOrama | null = null;

  get resourceUrl() {
    return this.configService.getCurrentResourceUrl();
  }

  constructor(
    private router: Router,
    private location: Location,
    private electronService: ElectronService,
    private projectService: ProjectService,
    private configService: ConfigService,
    private npmService: NpmService,
    private platformService: PlatformService,
    private cloudService: CloudService,
    private cd: ChangeDetectorRef,
    private translate: TranslateService,
    private message: NzMessageService
  ) {
    this.searchSubject.pipe(
      debounceTime(200),
      takeUntil(this.destroy$)
    ).subscribe(keyword => this.doSearch(keyword));
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async ngOnInit() {
    if (this.electronService.isElectron) {
      const pt = this.platformService.getPlatformSeparator();
      this.newProjectData.path = window['path'].getUserDocuments() + `${pt}aily-project${pt}`;
    }

    // 切换标题
    // this.electronService.setTitle('PROJECT_NEW.TITLE');

    await this.configService.init();

    const boardListWithLocal = await this.configService.loadBoardList();
    let processedBoardList = this.process(boardListWithLocal);

    // 按使用次数排序
    this._boardList = this.configService.sortBoardsByUsage(processedBoardList);

    this.boardList = this.applyLocalization(JSON.parse(JSON.stringify(this._boardList)));

    // 使用 selectBoard 方法来初始化，确保触发 checkHasExamples
    if (this.boardList.length > 0) {
      this.selectBoard(this.boardList[0]);
    }
    this.newProjectData.name = this.projectService.generateUniqueProjectName(this.newProjectData.path, 'project_');
    this.checkPathInvalidChars();
  }

  process(array) {
    let _array = JSON.parse(JSON.stringify(array));
    for (let index = 0; index < _array.length; index++) {
      const item = _array[index];
      // 为全文搜索做准备
      item['fulltext'] = `${item.nickname}${item.brand}${item.description}${item.keywords}`.replace(/\s/g, '').toLowerCase();
    }
    return _array;
  }

  search(keyword = this.keyword) {
    this.keyword = keyword;
    this.searchSubject.next(keyword);
  }

  private doSearch(keyword: string) {
    if (!keyword) {
      // 恢复完整列表（已按使用次数排序）
      this.boardList = this.applyLocalization(JSON.parse(JSON.stringify(this._boardList)));
      if (this.boardList.length > 0) {
        this.selectBoard(this.boardList[0]);
      }
      this.cd.detectChanges();
      return;
    }

    // 使用 Orama 进行模糊搜索
    const localizedList = this.applyLocalization(JSON.parse(JSON.stringify(this._boardList)));
    this.searchIndex = createBoardSearchIndex(localizedList);
    const matchedNames = searchBoards(this.searchIndex, keyword);

    // 按 Orama 返回的顺序（相关度排序）还原开发板对象
    const nameIndexMap = new Map<string, number>();
    matchedNames.forEach((name, i) => nameIndexMap.set(name, i));

    this.boardList = localizedList
      .filter(board => nameIndexMap.has(board.name))
      .sort((a, b) => (nameIndexMap.get(a.name) ?? 0) - (nameIndexMap.get(b.name) ?? 0));

    if (this.boardList.length > 0) {
      this.selectBoard(this.boardList[0]);
    } else {
      this.currentBoard = null;
    }
    this.cd.detectChanges();
  }

  devmodes = [];
  hasExamples = false;
  myTemplateList: CloudProjectTemplate[] = [];
  isLoadingTemplates = false;
  selectedTemplateName = '';

  get selectedTemplate(): CloudProjectTemplate | null {
    return this.myTemplateList.find(template => template.name === this.selectedTemplateName) || null;
  }

  get selectedTemplateDescription(): string {
    const description = this.selectedTemplate?.description?.trim() || '';
    if (description.length <= 20) {
      return description;
    }
    return `${description.slice(0, 20)}......`;
  }

  selectBoard(boardInfo: any) {
    this.currentBoard = boardInfo;
    this.newProjectData.board.name = boardInfo.name;
    this.newProjectData.board.nickname = boardInfo._nickname || boardInfo.nickname;
    this.newProjectData.board.version = boardInfo.version;
    this.newProjectData.board.sourcePath = boardInfo.sourcePath;
    this.newProjectData.devmode = boardInfo.mode ? this.currentBoard.mode[0] : 'arduino';
    this.devmodes = boardInfo.mode;
    this.checkHasExamples(boardInfo.name);
    this.loadMyTemplates(boardInfo.name);
  }

  checkHasExamples(boardName: string) {
    this.hasExamples = false;
    this.cloudService.getPublicProjects(1, 1, '', '', boardName).subscribe(res => {
      if (res && res.status === 200 && res.data && res.data.total > 0) {
        this.hasExamples = true;
        this.cd.detectChanges();
      }
    });
  }

  loadMyTemplates(boardName: string) {
    this.myTemplateList = [];
    this.selectedTemplateName = '';
    if (!boardName?.trim()) {
      this.isLoadingTemplates = false;
      this.cd.detectChanges();
      return;
    }

    this.isLoadingTemplates = true;
    this.cloudService.getMyTemplates(1, 20, boardName).subscribe({
      next: (res) => {
        if (res?.status === 200 && Array.isArray(res?.data?.list)) {
          this.myTemplateList = res.data.list;
        } else {
          this.myTemplateList = [];
        }
        this.selectedTemplateName = '';
        this.isLoadingTemplates = false;
        this.cd.detectChanges();
      },
      error: () => {
        this.myTemplateList = [];
        this.selectedTemplateName = '';
        this.isLoadingTemplates = false;
        this.cd.detectChanges();
      }
    });
  }

  // 可用版本列表
  boardVersionList: any[] = [];
  async nextStep() {
    if (!this.currentBoard || !isSupportedRobotDevice(this.newProjectData.board.name)) {
      this.message.error(this.translate.instant('ROBOTSTEM.UNSUPPORTED_DEVICE'));
      return;
    }
    this.boardVersionList = [this.newProjectData.board.version];
    this.currentStep = this.currentStep + 1;
    if (this.newProjectData.board.sourcePath) {
      return;
    }
    try {
      this.boardVersionList = (await this.npmService.getPackageVersionList(this.newProjectData.board.name)).reverse();
    } catch (error) {
      console.warn('获取开发板版本列表失败，使用当前版本:', error);
      this.boardVersionList = [this.newProjectData.board.version];
    }
  }

  async selectFolder() {
    const folderPath = await window['ipcRenderer'].invoke('select-folder', {
      path: this.newProjectData.path,
    });
    // console.log('选中的文件夹路径：', folderPath);
    const pt = this.platformService.getPlatformSeparator();
    if (folderPath.slice(-1) !== pt) {
      this.newProjectData.path = folderPath + pt;
    }
    this.checkPathInvalidChars();
  }

  // 检查项目名称是否存在
  showIsExist = false;
  async checkPathIsExist(): Promise<boolean> {
    const pt = this.platformService.getPlatformSeparator();
    let path = this.newProjectData.path + pt + this.newProjectData.name;
    let isExist = window['path'].isExists(path);
    if (isExist) {
      this.showIsExist = true;
    } else {
      this.showIsExist = false;
    }
    this.checkPathInvalidChars();
    return isExist;
  }

  // macOS 项目名称非法字符检查：/ \0 : 等（仅检查用户输入的项目名）
  showIsPathPassed = false;
  checkPathInvalidChars(): boolean {
    if (!this.platformService.isMac()) {
      this.showIsPathPassed = false;
      return false;
    }
    // macOS 文件名特殊及非法字符：/ \0 : \ * ? " < > | \n \r 等
    const invalidChars = /[\s\0:\\*?^$!#%&()=+`~'"<>|\n\r]/;
    console.log('invalidChars: ', this.newProjectData.path);
    const hasInvalid = invalidChars.test(this.newProjectData.path);
    this.showIsPathPassed = hasInvalid;
    return hasInvalid;
  }

  async createProject() {
    // 判断是否有同名项目
    if (await this.checkPathIsExist()) {
      return;
    }
    // macOS 路径非法字符检查
    if (this.checkPathInvalidChars()) {
      return;
    }
    this.currentStep = 2;

    // 记录开发板使用次数
    this.configService.recordBoardUsage(this.newProjectData.board.name);

    let success = false;
    let extractPath = '';
    try {
      if (this.selectedTemplateName) {
        const templateProject = await this.findSelectedTemplateProject();
        if (!templateProject?.archive_url) {
          throw new Error('未找到所选模板的归档文件');
        }

        const archiveUrl = `${this.cloudService.baseUrl}${templateProject.archive_url}`;
        extractPath = await firstValueFrom(this.cloudService.getProjectArchive(archiveUrl));
        success = await this.projectService.projectNewFromTemplate(this.newProjectData, extractPath);
      } else {
        success = await this.projectService.projectNew(this.newProjectData);
      }
    } catch (error: any) {
      const message = typeof error === 'string' ? error : (error?.message || '创建项目失败');
      this.message.error(message);
    } finally {
      if (extractPath) {
        this.cloudService.cleanupExtractedFiles(extractPath);
      }
    }

    if (!success) {
      this.currentStep = 1;
    }
  }

  private async findSelectedTemplateProject(): Promise<any> {
    const selectedTemplate = this.selectedTemplate;
    if (!selectedTemplate) {
      return null;
    }

    const pageSize = 100;
    let page = 1;
    let total = 0;

    do {
      const res = await firstValueFrom(this.cloudService.getProjects(page, pageSize));
      const projects = Array.isArray(res?.data?.list) ? res.data.list : [];
      total = Number(res?.data?.total || 0);

      const matchedProject = projects.find((project: any) => (
        project?.is_template === true &&
        project?.name === selectedTemplate.name &&
        (project?.nickname || '') === (selectedTemplate.nickname || '') &&
        (project?.description || '') === (selectedTemplate.description || '')
      ));

      if (matchedProject) {
        return matchedProject;
      }

      page += 1;
    } while ((page - 1) * pageSize < total);

    throw new Error('未找到所选模板项目');
  }

  openUrl(url) {
    this.electronService.openUrl(url);
  }

  help() {
    this.electronService.openUrl("https://www.bitcraze.io/documentation/");
  }

  back() {
    // 检查是否有历史记录可以返回
    if (window.history.length > 1) {
      this.location.back();
    } else {
      // 如果没有历史记录，跳转到项目初始默认路径
      this.router.navigate(['/main/guide']);
    }
  }

  nextStepFromProjectHub() {
    this.router.navigate(['main', 'playground', 'list'], { queryParams: { board: this.currentBoard.name } })
    // this.router.navigate(['/main/playground']);
  }

  private applyLocalization(list: any[]) {
    const lang = this.translate.currentLang;
    for (const board of list) {
      board._nickname = (lang && board[`nickname_${lang}`]) || board.nickname || '';
      board._description = (lang && board[`description_${lang}`]) || board.description || '';
    }
    return list;
  }

  getBoardImageSrc(board: any): string {
    const localPath = board?.imgLocalPath;
    if (typeof localPath === 'string' && localPath.length > 0 && window['path'].isExists(localPath)) {
      const normalized = localPath.replace(/\\/g, '/');
      return `file:///${normalized}`;
    }

    const img = String(board?.img || '');
    if (/^(https?:|data:|file:\/\/)/i.test(img)) {
      return img;
    }

    return `${this.resourceUrl}/imgs/boards/${img}`;
  }
}


export interface BoardInfo {
  "name": string, // 开发板在仓库中的名称开发板名称
  "nickname": string, // 显示的开发板名称
  "version": string,
  "img": string,
  "description": string,
  "url": string,
  "brand": string,
  "type"?: string, // 开发板类型/核心架构 (如 esp32:esp32, arduino:avr, etc)
  "mode"?: string[],
  "sourcePath"?: string,
  "imgLocalPath"?: string
}

export interface NewProjectData {
  name: string,
  path: string,
  board: {
    name: string,
    nickname: string,
    version: string,
    sourcePath?: string
  },
  devmode?: string
}

interface CloudProjectTemplate {
  name: string;
  nickname?: string;
  description?: string;
}
