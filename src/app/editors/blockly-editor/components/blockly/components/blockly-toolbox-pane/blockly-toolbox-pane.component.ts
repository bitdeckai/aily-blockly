import { CommonModule } from '@angular/common';
import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, EventEmitter, HostBinding, NgZone, OnDestroy, OnInit, Output } from '@angular/core';
import { Subject, combineLatest } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import {
  BLOCKLY_TOOLBOX_SEARCH_KEY,
  BlocklyService,
  BlocklyToolboxFacadeItem,
} from '../../../../services/blockly.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MenuComponent } from '../../../../../../components/menu/menu.component';
import { IMenuItem } from '../../../../../../configs/menu.config';
import { ElectronService } from '../../../../../../services/electron.service';
import { ProjectService } from '../../../../../../services/project.service';
import { CmdService } from '../../../../../../services/cmd.service';
import { WorkflowService } from '../../../../../../services/workflow.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import Sortable, { SortableEvent } from 'sortablejs';

interface ToolboxContextMenuAction {
  name: string;
  action: string;
  icon: string;
  handler: (item: BlocklyToolboxFacadeItem) => void | Promise<void>;
  disabled?: (item: BlocklyToolboxFacadeItem) => boolean;
}

interface DeckShortcut {
  label: string;
  search: string;
}

interface DeckBoundItem {
  key: string;
  label: string;
}

interface DeckStarterBlock {
  label: string;
  search: string;
}

interface DeckGroup {
  key: string;
  name: string;
  iconClass: string;
  expanded: boolean;
  boundItems: DeckBoundItem[];
  starterBlocks: DeckStarterBlock[];
  shortcuts: DeckShortcut[];
  allTargetKey?: string | null;
  allSearchQuery?: string;
}

@Component({
  selector: 'app-blockly-toolbox-pane',
  imports: [CommonModule, TranslateModule, MenuComponent],
  templateUrl: './blockly-toolbox-pane.component.html',
  styleUrl: './blockly-toolbox-pane.component.scss',
})
export class BlocklyToolboxPaneComponent implements OnInit, AfterViewInit, OnDestroy {
  @Output() libraryManagerRequested = new EventEmitter<void>();

  readonly searchKey = BLOCKLY_TOOLBOX_SEARCH_KEY;

  items: BlocklyToolboxFacadeItem[] = [];
  selectedKey: string | null = null;
  searchQuery = '';
  showContextMenu = false;
  dragVisualActive = false;
  hoverSuppressed = false;
  deckGroups: DeckGroup[] = [
    {
      key: 'flow-v2',
      name: 'Flow deck v2',
      iconClass: 'fa-light fa-arrows-up-down-left-right',
      expanded: false,
      boundItems: [],
      starterBlocks: [
        { label: '起飞', search: 'takeoff' },
        { label: '降落', search: 'land' },
        { label: '向前飞', search: 'move forward' },
        { label: '向上飞', search: 'move up' },
        { label: '探测Flow v2', search: 'cf_detect_flow_v2 bcFlow2 flow deck detect' },
      ],
      shortcuts: [
        { label: '起飞/降落', search: 'takeoff land' },
        { label: '前后左右移动', search: 'move forward back left right' },
        { label: '上下移动', search: 'move up down' },
        { label: '等待', search: 'delay wait' },
      ],
    },
    {
      key: 'multiranger',
      name: 'Multiranger deck',
      iconClass: 'fa-light fa-radar',
      expanded: false,
      boundItems: [],
      starterBlocks: [
        { label: '探测Multiranger', search: 'cf_detect_multiranger' },
        { label: '前后左右上距离', search: 'cf_mr_get_distance cf_mr_log_all_distances' },
        { label: '有障碍物？', search: 'cf_mr_has_obstacle' },
        { label: '单向距离打印', search: 'cf_mr_log_distance' },
      ],
      shortcuts: [
        { label: '前后左右上距离', search: 'range front back left right up' },
        { label: '是否有障碍物', search: 'obstacle if' },
        { label: '避障逻辑', search: 'avoid obstacle' },
      ],
    },
    {
      key: 'led-ring',
      name: 'LED-ring deck',
      iconClass: 'fa-light fa-circle-dot',
      expanded: false,
      boundItems: [],
      starterBlocks: [
        { label: '探测LED-ring', search: 'cf_detect_led_ring deck bcColorLedTop bcColorLedBot' },
        { label: '设置颜色', search: 'cf_led_ring_set_color ring.solidRed ring.solidGreen ring.solidBlue' },
        { label: '设置灯效', search: 'cf_led_ring_set_effect ring.effect' },
        { label: '关闭灯环', search: 'cf_led_ring_off ring.effect 0' },
      ],
      shortcuts: [
        { label: '设置颜色', search: 'led color' },
        { label: '闪烁/呼吸', search: 'led blink breathe' },
        { label: '灯效模式', search: 'led effect ring' },
      ],
    },
    {
      key: 'buzzer',
      name: 'Buzzer deck',
      iconClass: 'fa-light fa-volume',
      expanded: false,
      boundItems: [],
      starterBlocks: [
        { label: '探测Buzzer', search: 'cf_detect_buzzer deck bcBuzzer' },
        { label: '蜂鸣', search: 'cf_buzzer_beep sound.effect' },
        { label: '提示音', search: 'cf_buzzer_beep duration times' },
        { label: '旋律', search: 'buzzer melody note (planned)' },
      ],
      shortcuts: [
        { label: '蜂鸣', search: 'buzzer beep tone' },
        { label: '提示音', search: 'sound alert' },
        { label: '旋律', search: 'melody note' },
      ],
    },
  ];
  contextMenuPosition = { x: 0, y: 0 };
  contextMenuItems: IMenuItem[] = [];
  contextMenuTarget: BlocklyToolboxFacadeItem | null = null;

  readonly toolboxContextMenuActions: ToolboxContextMenuAction[] = [
    // 资源管理器中打开库所在位置
    {
      name: 'MENU.OPEN_IN_EXPLORER',
      action: 'open-library-path',
      icon: 'fa-light fa-browser',
      handler: (item) => this.openLibraryPath(item),
      disabled: (item) => !item.libraryPath,
    },
    // 移除该库
    {
      name: 'LIB_MANAGER.REMOVE',
      action: 'remove-library',
      icon: 'fa-light fa-trash-can',
      handler: (item) => this.removeLibrary(item),
      disabled: (item) => !item.libraryName || !item.libraryPath || this.removingLibraryNames.has(item.libraryName),
    },
  ];

  private destroy$ = new Subject<void>();
  private removingLibraryNames = new Set<string>();
  private sortableInstances = new Map<HTMLElement, Sortable>();
  private sortableSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverSuppressPointerMoveHandler: ((event: PointerEvent) => void) | null = null;
  private dragSorting = false;
  private lastDragEndAt = 0;
  private readonly toolboxOrderPackageKey = 'blocklyToolboxOrder';

  @HostBinding('class.toolbox-pane--sorting')
  get isSortingVisualActive(): boolean {
    return this.dragVisualActive;
  }

  @HostBinding('class.toolbox-pane--suppress-hover')
  get isHoverSuppressed(): boolean {
    return this.hoverSuppressed;
  }

  // get isSearchActive(): boolean {
  //   return this.selectedKey === this.searchKey;
  // }

  constructor(
    private blocklyService: BlocklyService,
    private cdr: ChangeDetectorRef,
    private ngZone: NgZone,
    private electronService: ElectronService,
    private projectService: ProjectService,
    private cmdService: CmdService,
    private workflowService: WorkflowService,
    private message: NzMessageService,
    private translate: TranslateService,
    private elementRef: ElementRef<HTMLElement>,
  ) { }

  ngOnInit(): void {
    combineLatest([
      this.blocklyService.toolboxFacadeItemsSubject,
      this.blocklyService.toolboxSelectedKeySubject,
      this.blocklyService.toolboxSearchQuerySubject,
    ])
      .pipe(takeUntil(this.destroy$))
      .subscribe(([items, selectedKey, searchQuery]) => {
        this.ngZone.run(() => {
          this.items = items;
          this.refreshDeckBindings(items);
          this.selectedKey = selectedKey;
          this.searchQuery = searchQuery;
          if (this.contextMenuTarget && !this.findItemByKey(this.contextMenuTarget.key, items)) {
            this.closeContextMenu();
          }
          this.cdr.markForCheck();
          this.scheduleSortableSync();
        });
      });
  }

  ngAfterViewInit(): void {
    this.scheduleSortableSync();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.sortableSyncTimer) {
      clearTimeout(this.sortableSyncTimer);
    }
    this.removeHoverSuppressPointerListener();
    this.destroySortables();
  }

  trackItem(_index: number, item: BlocklyToolboxFacadeItem): string {
    return item.key;
  }

  trackDeck(_index: number, deck: DeckGroup): string {
    return deck.key;
  }

  trackDeckBoundItem(_index: number, item: DeckBoundItem): string {
    return item.key;
  }

  onSearchFocus() {
    this.blocklyService.activateToolboxSearch();
  }

  onSearchInput(event: Event) {
    const query = (event.target as HTMLInputElement).value;
    this.blocklyService.setToolboxSearchQuery(query);
  }

  onSearchClear() {
    this.blocklyService.clearToolboxSearch();
  }

  onCategoryClick(item: BlocklyToolboxFacadeItem) {
    if (this.shouldIgnoreCategoryClick()) {
      return;
    }

    this.blocklyService.clickToolboxFacadeItem(item.key);
  }

  onToggleClick(item: BlocklyToolboxFacadeItem, event: MouseEvent) {
    event.stopPropagation();
    this.blocklyService.toggleToolboxFacadeItem(item.key);
  }

  onToolboxItemContextMenu(item: BlocklyToolboxFacadeItem, event: MouseEvent) {
    if (!this.hasLibraryContextMenu(item)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    this.contextMenuTarget = item;
    this.contextMenuItems = this.toolboxContextMenuActions.map(action => ({
      name: action.name,
      action: action.action,
      icon: action.icon,
      disabled: action.disabled?.(item) || false,
    }));
    this.contextMenuPosition = { x: event.clientX, y: event.clientY };
    this.showContextMenu = true;
  }

  async onContextMenuItemClick(menuItem: IMenuItem) {
    const target = this.contextMenuTarget;
    const action = this.toolboxContextMenuActions.find(item => item.action === menuItem.action);
    this.closeContextMenu();

    if (!target || !action || menuItem.disabled) {
      return;
    }

    await action.handler(target);
  }

  closeContextMenu() {
    this.showContextMenu = false;
    this.contextMenuTarget = null;
    this.contextMenuItems = [];
  }

  onLibraryManagerClick() {
    this.libraryManagerRequested.emit();
  }

  get showDeckPanel(): boolean {
    return this.items.some((item) => String(item.name || '').toLowerCase().includes('crazyflie'));
  }

  get crazyflieRootItem(): BlocklyToolboxFacadeItem | null {
    return this.items.find((item) => String(item.name || '').toLowerCase().includes('crazyflie')) || null;
  }

  get toolboxVisibleItems(): BlocklyToolboxFacadeItem[] {
    if (!this.showDeckPanel) {
      return this.items;
    }

    return this.items.filter((item) => String(item.name || '').toLowerCase().trim() !== 'crazyflie');
  }

  onDeckRowClick(deckKey: string): void {
    this.deckGroups = this.deckGroups.map((deck) =>
      deck.key === deckKey ? { ...deck, expanded: !deck.expanded } : deck,
    );
  }

  onDeckShortcutClick(search: string): void {
    this.blocklyService.activateToolboxSearch();
    this.blocklyService.setToolboxSearchQuery(search);
  }

  onDeckStarterBlockClick(search: string): void {
    this.blocklyService.activateToolboxSearch();
    this.blocklyService.setToolboxSearchQuery(search);
  }

  onDeckBoundItemClick(itemKey: string): void {
    if (itemKey.startsWith('__deck_all__:')) {
      const deckKey = itemKey.replace('__deck_all__:', '');
      this.onDeckShowAll(deckKey);
      return;
    }

    const item = this.findItemByKey(itemKey, this.items);
    if (!item) {
      return;
    }

    this.blocklyService.clickToolboxFacadeItem(item.key);
  }

  private onDeckShowAll(deckKey: string): void {
    const deck = this.deckGroups.find((item) => item.key === deckKey);
    if (!deck) {
      return;
    }

    if (deck.allTargetKey) {
      this.blocklyService.clearToolboxSearch();
      this.blocklyService.clickToolboxFacadeItem(deck.allTargetKey);
      return;
    }

    const query = String(deck.allSearchQuery || '').trim();
    if (!query) {
      return;
    }

    this.blocklyService.activateToolboxSearch();
    this.blocklyService.setToolboxSearchQuery(query);
  }

  private refreshDeckBindings(items: BlocklyToolboxFacadeItem[]): void {
    const candidates = this.flattenToolboxItems(items)
      .filter((item) => item.selectable && item.level > 0)
      .filter((item) => {
        const name = String(item.name || '').toLowerCase().trim();
        return !!name && name !== 'crazyflie';
      });

    const deckMatchers: Array<{ key: string; pattern: RegExp }> = [
      { key: 'multiranger', pattern: /(multiranger|ranger|distance|obstacle|range|tof|距离|避障|前方|后方|左侧|右侧|上方)/i },
      { key: 'led-ring', pattern: /(led|ring|light|color|blink|breathe|rainbow|灯|颜色|闪烁|呼吸)/i },
      { key: 'buzzer', pattern: /(buzzer|beep|tone|sound|melody|note|蜂鸣|声音|旋律|音符)/i },
      { key: 'flow-v2', pattern: /(flow|takeoff|land|move|hover|delay|wait|height|起飞|降落|移动|悬停|等待|高度)/i },
    ];

    const grouped = new Map<string, BlocklyToolboxFacadeItem[]>();
    deckMatchers.forEach((deck) => grouped.set(deck.key, []));

    candidates.forEach((item) => {
      const text = `${item.name || ''} ${item.key || ''}`;
      const deck = deckMatchers.find((entry) => entry.pattern.test(text));
      if (!deck) {
        return;
      }

      const list = grouped.get(deck.key);
      if (!list || list.some((boundItem) => boundItem.key === item.key)) {
        return;
      }

      list.push(item);
    });

    this.deckGroups = this.deckGroups.map((deck) => ({
      ...deck,
      boundItems: this.buildDeckBoundItems(deck.key, grouped.get(deck.key) || []),
      allTargetKey: this.resolveDeckAllTargetKey(grouped.get(deck.key) || []),
      allSearchQuery: this.buildDeckAllSearchQuery(deck, grouped.get(deck.key) || []),
    }));
  }

  private buildDeckBoundItems(deckKey: string, items: BlocklyToolboxFacadeItem[]): DeckBoundItem[] {
    const dedup = new Map<string, DeckBoundItem>();
    items.forEach((item) => {
      if (!dedup.has(item.key)) {
        dedup.set(item.key, { key: item.key, label: item.name || item.key });
      }
    });

    return [{ key: `__deck_all__:${deckKey}`, label: '所有' }, ...Array.from(dedup.values())];
  }

  private resolveDeckAllTargetKey(items: BlocklyToolboxFacadeItem[]): string | null {
    if (!items.length) {
      return null;
    }

    const preferred = [...items].sort((a, b) => {
      if (a.level !== b.level) {
        return a.level - b.level;
      }
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    return preferred[0]?.key || null;
  }

  private buildDeckAllSearchQuery(deck: DeckGroup, items: BlocklyToolboxFacadeItem[]): string {
    const terms = new Set<string>();

    terms.add(deck.name);
    terms.add(deck.key.replace(/-/g, ' '));
    terms.add('deck detect');

    items.forEach((item) => {
      terms.add(String(item.name || ''));
      terms.add(String(item.key || '').replace(/_/g, ' '));
    });

    deck.starterBlocks.forEach((item) => terms.add(item.search));
    deck.shortcuts.forEach((item) => terms.add(item.search));

    return Array.from(terms)
      .map((item) => item.trim())
      .filter((item) => !!item)
      .join(' ');
  }

  private flattenToolboxItems(items: BlocklyToolboxFacadeItem[]): BlocklyToolboxFacadeItem[] {
    const result: BlocklyToolboxFacadeItem[] = [];
    const visit = (nodes: BlocklyToolboxFacadeItem[]) => {
      nodes.forEach((node) => {
        result.push(node);
        if (node.children.length) {
          visit(node.children);
        }
      });
    };
    visit(items);
    return result;
  }

  private scheduleSortableSync() {
    if (this.sortableSyncTimer) {
      clearTimeout(this.sortableSyncTimer);
    }

    this.sortableSyncTimer = setTimeout(() => {
      this.sortableSyncTimer = null;
      this.syncSortableContainers();
    }, 0);
  }

  private syncSortableContainers() {
    const containers = Array.from(this.elementRef.nativeElement.querySelectorAll<HTMLElement>('[data-toolbox-sortable-container="true"]'));
    const activeContainers = new Set(containers);

    this.sortableInstances.forEach((sortable, container) => {
      if (!activeContainers.has(container) || !container.isConnected) {
        sortable.destroy();
        this.sortableInstances.delete(container);
      }
    });

    containers.forEach((container) => {
      if (this.sortableInstances.has(container)) {
        return;
      }

      this.ngZone.runOutsideAngular(() => {
        const sortable = Sortable.create(container, {
          animation: 150,
          draggable: '.toolbox-node--sortable',
          handle: '.toolbox-row--sortable-handle',
          delay: 200,
          delayOnTouchOnly: false,
          touchStartThreshold: 10,
          fallbackTolerance: 4,
          ghostClass: 'toolbox-node--drag-ghost',
          chosenClass: 'toolbox-node--drag-chosen',
          dragClass: 'toolbox-node--dragging',
          filter: '.toolbox-item__toggle',
          preventOnFilter: false,
          onChoose: (event: SortableEvent) => {
            this.ngZone.run(() => {
              this.enterDragVisualMode(event.item);
            });
          },
          onStart: (event: SortableEvent) => {
            this.ngZone.run(() => {
              this.dragSorting = true;
              this.enterDragVisualMode(event.item);
            });
          },
          onUnchoose: () => {
            this.ngZone.run(() => {
              if (!this.dragSorting) {
                this.setDragVisualActive(false);
              }
            });
          },
          onEnd: (event: SortableEvent) => {
            this.ngZone.run(() => this.onToolboxSortEnd(event));
          },
        });

        this.sortableInstances.set(container, sortable);
      });
    });
  }

  private async onToolboxSortEnd(event: SortableEvent) {
    this.dragSorting = false;
    this.setDragVisualActive(false);
    this.suppressHoverAfterDragEnd();
    this.lastDragEndAt = Date.now();

    const itemKey = event.item.getAttribute('data-toolbox-key');
    const nextIndex = event.newDraggableIndex ?? event.newIndex ?? -1;

    if (!itemKey || nextIndex < 0 || event.oldIndex === event.newIndex) {
      this.scheduleSortableSync();
      return;
    }

    const moved = this.blocklyService.moveToolboxFacadeItem(itemKey, nextIndex);
    if (!moved) {
      this.scheduleSortableSync();
      return;
    }

    try {
      await this.persistToolboxOrder();
    } catch (error) {
      console.error('保存工具箱顺序失败:', error);
      this.message.error('保存工具箱顺序失败');
    } finally {
      this.scheduleSortableSync();
      this.cdr.markForCheck();
    }
  }

  private async persistToolboxOrder() {
    const packageJson = await this.projectService.getPackageJson();
    if (!packageJson) {
      return;
    }

    packageJson[this.toolboxOrderPackageKey] = this.blocklyService.getToolboxSortOrder();
    await this.projectService.setPackageJson(packageJson);
  }

  private shouldIgnoreCategoryClick(): boolean {
    return this.dragSorting || Date.now() - this.lastDragEndAt < 250;
  }

  private destroySortables() {
    this.sortableInstances.forEach((sortable) => sortable.destroy());
    this.sortableInstances.clear();
  }

  private enterDragVisualMode(itemElement?: HTMLElement) {
    if (itemElement) {
      this.closeDraggedItemBeforeSort(itemElement);
    }

    this.selectedKey = null;
    this.blocklyService.clearToolboxSelection();
    this.setDragVisualActive(true);
    this.closeContextMenu();
  }

  private closeDraggedItemBeforeSort(itemElement: HTMLElement) {
    const itemKey = itemElement.getAttribute('data-toolbox-key');
    if (!itemKey) {
      return;
    }

    const item = this.findItemByKey(itemKey, this.items);
    if (!item) {
      return;
    }

    if (this.selectedKey === item.key) {
      this.selectedKey = null;
      this.blocklyService.clearToolboxSelection();
    }

    if (item.isCollapsible && item.expanded) {
      this.blocklyService.collapseToolboxFacadeItem(item.key);
    }
  }

  private setDragVisualActive(active: boolean) {
    if (active) {
      this.setHoverSuppressed(false);
    }

    if (this.dragVisualActive === active) {
      return;
    }

    this.dragVisualActive = active;
    this.cdr.markForCheck();
  }

  private suppressHoverAfterDragEnd() {
    this.setHoverSuppressed(true);
    this.removeHoverSuppressPointerListener();

    this.hoverSuppressPointerMoveHandler = () => {
      this.ngZone.run(() => this.setHoverSuppressed(false));
    };
    document.addEventListener('pointermove', this.hoverSuppressPointerMoveHandler, { capture: true, once: true });
  }

  private setHoverSuppressed(suppressed: boolean) {
    if (!suppressed) {
      this.removeHoverSuppressPointerListener();
    }

    if (this.hoverSuppressed === suppressed) {
      return;
    }

    this.hoverSuppressed = suppressed;
    this.cdr.markForCheck();
  }

  private removeHoverSuppressPointerListener() {
    if (!this.hoverSuppressPointerMoveHandler) {
      return;
    }

    document.removeEventListener('pointermove', this.hoverSuppressPointerMoveHandler, { capture: true });
    this.hoverSuppressPointerMoveHandler = null;
  }

  private hasLibraryContextMenu(item: BlocklyToolboxFacadeItem): boolean {
    return !!item.libraryName && !!item.libraryPath;
  }

  private openLibraryPath(item: BlocklyToolboxFacadeItem) {
    if (!item.libraryPath) {
      return;
    }

    this.electronService.openByExplorer(item.libraryPath);
  }

  private async removeLibrary(item: BlocklyToolboxFacadeItem) {
    const libraryName = item.libraryName;
    const libraryPath = item.libraryPath;
    if (!libraryName || !libraryPath || this.removingLibraryNames.has(libraryName)) {
      return;
    }

    if (this.blocklyService.isLibraryUsedByCurrentProject(libraryPath)) {
      this.message.warning(this.translate.instant('LIB_MANAGER.LIB_IN_USE'), { nzDuration: 5000 });
      return;
    }

    this.removingLibraryNames.add(libraryName);
    const workflowStarted = this.workflowService.startInstall();
    let libraryRemoved = false;

    try {
      this.message.loading(`${this.getLibraryDisplayName(item)} ${this.translate.instant('LIB_MANAGER.UNINSTALLING')}...`);
      this.blocklyService.removeLibrary(libraryPath);
      libraryRemoved = true;

      const { code, stderr } = await this.cmdService.runAsync(`npm uninstall ${libraryName}`, this.projectService.currentProjectPath);
      if (code !== 0) {
        throw new Error(stderr || `退出码: ${code}`);
      }

      this.message.success(`${this.getLibraryDisplayName(item)} ${this.translate.instant('LIB_MANAGER.UNINSTALLED')}`);
      if (workflowStarted) {
        this.workflowService.finishInstall(true);
      }
    } catch (error) {
      const errorMessage = this.getErrorMessage(error, 'Uninstall failed');
      if (libraryRemoved) {
        await this.blocklyService.loadLibrary(libraryName, this.projectService.currentProjectPath);
      }
      this.message.error(`${this.getLibraryDisplayName(item)} ${this.translate.instant('NPM.UNINSTALL_FAILED_TITLE')}: ${errorMessage}`);
      if (workflowStarted) {
        this.workflowService.finishInstall(false, errorMessage);
      }
    } finally {
      this.removingLibraryNames.delete(libraryName);
      this.cdr.markForCheck();
    }
  }

  private getLibraryDisplayName(item: BlocklyToolboxFacadeItem): string {
    return item.name || item.libraryName || '';
  }

  private getErrorMessage(error: unknown, fallback: string): string {
    let message = fallback;
    if (error instanceof Error && error.message) {
      message = error.message;
    } else if (typeof error === 'string' && error) {
      message = error;
    }

    return message.length > 240 ? `${message.slice(0, 240)}...` : message;
  }

  private findItemByKey(itemKey: string, items: BlocklyToolboxFacadeItem[]): BlocklyToolboxFacadeItem | null {
    for (const item of items) {
      if (item.key === itemKey) {
        return item;
      }

      const child = this.findItemByKey(itemKey, item.children);
      if (child) {
        return child;
      }
    }

    return null;
  }
}
