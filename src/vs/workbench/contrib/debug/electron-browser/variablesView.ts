/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { RunOnceScheduler } from 'vs/base/common/async';
import * as dom from 'vs/base/browser/dom';
import { CollapseAction } from 'vs/workbench/browser/viewlet';
import { IViewletViewOptions } from 'vs/workbench/browser/parts/views/viewsViewlet';
import { IDebugService, IExpression, IScope, CONTEXT_VARIABLES_FOCUSED, IViewModel } from 'vs/workbench/contrib/debug/common/debug';
import { Variable, Scope } from 'vs/workbench/contrib/debug/common/debugModel';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { renderViewTree, renderVariable, IInputBoxOptions, AbstractExpressionsRenderer, IExpressionTemplateData } from 'vs/workbench/contrib/debug/browser/baseDebugView';
import { IAction } from 'vs/base/common/actions';
import { SetValueAction, AddToWatchExpressionsAction } from 'vs/workbench/contrib/debug/browser/debugActions';
import { CopyValueAction, CopyEvaluatePathAction } from 'vs/workbench/contrib/debug/electron-browser/electronDebugActions';
import { Separator } from 'vs/base/browser/ui/actionbar/actionbar';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IViewletPanelOptions, ViewletPanel } from 'vs/workbench/browser/parts/views/panelViewlet';
import { IAccessibilityProvider } from 'vs/base/browser/ui/list/listWidget';
import { IListVirtualDelegate } from 'vs/base/browser/ui/list/list';
import { ITreeRenderer, ITreeNode, ITreeMouseEvent, ITreeContextMenuEvent, IAsyncDataSource } from 'vs/base/browser/ui/tree/tree';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Emitter } from 'vs/base/common/event';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { WorkbenchAsyncDataTree, IListService } from 'vs/platform/list/browser/listService';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { onUnexpectedError } from 'vs/base/common/errors';
import { FuzzyScore, createMatches } from 'vs/base/common/filters';
import { HighlightedLabel, IHighlight } from 'vs/base/browser/ui/highlightedlabel/highlightedLabel';

const $ = dom.$;

export const variableSetEmitter = new Emitter<void>();

export class VariablesView extends ViewletPanel {

	private onFocusStackFrameScheduler: RunOnceScheduler;
	private needsRefresh: boolean;
	private tree: WorkbenchAsyncDataTree<IViewModel | IExpression | IScope, IExpression | IScope, FuzzyScore>;

	constructor(
		options: IViewletViewOptions,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IDebugService private readonly debugService: IDebugService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IListService private readonly listService: IListService,
		@IThemeService private readonly themeService: IThemeService
	) {
		super({ ...(options as IViewletPanelOptions), ariaHeaderLabel: nls.localize('variablesSection', "Variables Section") }, keybindingService, contextMenuService, configurationService);

		// Use scheduler to prevent unnecessary flashing
		this.onFocusStackFrameScheduler = new RunOnceScheduler(() => {
			this.needsRefresh = false;
			this.tree.updateChildren().then(() => {
				const stackFrame = this.debugService.getViewModel().focusedStackFrame;
				if (stackFrame) {
					stackFrame.getScopes().then(scopes => {
						// Expand the first scope if it is not expensive and if there is no expansion state (all are collapsed)
						if (scopes.every(s => this.tree.getNode(s).collapsed) && scopes.length > 0 && !scopes[0].expensive) {
							this.tree.expand(scopes[0]).then(undefined, onUnexpectedError);
						}
					});
				}
			}, onUnexpectedError);
		}, 400);
	}

	renderBody(container: HTMLElement): void {
		dom.addClass(container, 'debug-variables');
		const treeContainer = renderViewTree(container);

		this.tree = new WorkbenchAsyncDataTree(treeContainer, new VariablesDelegate(),
			[this.instantiationService.createInstance(VariablesRenderer), new ScopesRenderer()],
			new VariablesDataSource(), {
				ariaLabel: nls.localize('variablesAriaTreeLabel', "Debug Variables"),
				accessibilityProvider: new VariablesAccessibilityProvider(),
				identityProvider: { getId: element => element.getId() },
				keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: e => e }
			}, this.contextKeyService, this.listService, this.themeService, this.configurationService, this.keybindingService);

		this.tree.setInput(this.debugService.getViewModel()).then(null, onUnexpectedError);

		CONTEXT_VARIABLES_FOCUSED.bindTo(this.tree.contextKeyService);

		const collapseAction = new CollapseAction(this.tree, true, 'explorer-action collapse-explorer');
		this.toolbar.setActions([collapseAction])();
		this.tree.updateChildren();

		this.disposables.push(this.debugService.getViewModel().onDidFocusStackFrame(sf => {
			if (!this.isBodyVisible()) {
				this.needsRefresh = true;
				return;
			}

			// Refresh the tree immediately if the user explictly changed stack frames.
			// Otherwise postpone the refresh until user stops stepping.
			const timeout = sf.explicit ? 0 : undefined;
			this.onFocusStackFrameScheduler.schedule(timeout);
		}));
		this.disposables.push(variableSetEmitter.event(() => this.tree.updateChildren()));
		this.disposables.push(this.tree.onMouseDblClick(e => this.onMouseDblClick(e)));
		this.disposables.push(this.tree.onContextMenu(e => this.onContextMenu(e)));

		this.disposables.push(this.onDidChangeBodyVisibility(visible => {
			if (visible && this.needsRefresh) {
				this.onFocusStackFrameScheduler.schedule();
			}
		}));
		this.disposables.push(this.debugService.getViewModel().onDidSelectExpression(e => {
			if (e instanceof Variable) {
				this.tree.rerender(e);
			}
		}));
	}

	layoutBody(width: number, height: number): void {
		this.tree.layout(width, height);
	}

	focus(): void {
		this.tree.domFocus();
	}

	private onMouseDblClick(e: ITreeMouseEvent<IExpression | IScope>): void {
		const session = this.debugService.getViewModel().focusedSession;
		if (session && e.element instanceof Variable && session.capabilities.supportsSetVariable) {
			this.debugService.getViewModel().setSelectedExpression(e.element);
		}
	}

	private onContextMenu(e: ITreeContextMenuEvent<IExpression | IScope>): void {
		const element = e.element;
		const anchor = e.anchor;
		if (element instanceof Variable && !!element.value && anchor) {
			const actions: IAction[] = [];
			const variable = element as Variable;
			actions.push(new SetValueAction(SetValueAction.ID, SetValueAction.LABEL, variable, this.debugService, this.keybindingService));
			actions.push(new CopyValueAction(CopyValueAction.ID, CopyValueAction.LABEL, variable, 'variables', this.debugService));
			actions.push(new CopyEvaluatePathAction(CopyEvaluatePathAction.ID, CopyEvaluatePathAction.LABEL, variable));
			actions.push(new Separator());
			actions.push(new AddToWatchExpressionsAction(AddToWatchExpressionsAction.ID, AddToWatchExpressionsAction.LABEL, variable, this.debugService, this.keybindingService));

			this.contextMenuService.showContextMenu({
				getAnchor: () => anchor,
				getActions: () => actions,
				getActionsContext: () => element
			});
		}
	}
}

function isViewModel(obj: any): obj is IViewModel {
	return typeof obj.getSelectedExpression === 'function';
}

export class VariablesDataSource implements IAsyncDataSource<IViewModel, IExpression | IScope> {

	hasChildren(element: IViewModel | IExpression | IScope): boolean {
		if (isViewModel(element) || element instanceof Scope) {
			return true;
		}

		return element.hasChildren;
	}

	getChildren(element: IViewModel | IExpression | IScope): Promise<(IExpression | IScope)[]> {
		if (isViewModel(element)) {
			const stackFrame = element.focusedStackFrame;
			return stackFrame ? stackFrame.getScopes() : Promise.resolve([]);
		}

		return element.getChildren();
	}
}

interface IScopeTemplateData {
	name: HTMLElement;
	label: HighlightedLabel;
}

class VariablesDelegate implements IListVirtualDelegate<IExpression | IScope> {

	getHeight(element: IExpression | IScope): number {
		return 22;
	}

	getTemplateId(element: IExpression | IScope): string {
		if (element instanceof Scope) {
			return ScopesRenderer.ID;
		}

		return VariablesRenderer.ID;
	}
}

class ScopesRenderer implements ITreeRenderer<IScope, FuzzyScore, IScopeTemplateData> {

	static readonly ID = 'scope';

	get templateId(): string {
		return ScopesRenderer.ID;
	}

	renderTemplate(container: HTMLElement): IScopeTemplateData {
		const name = dom.append(container, $('.scope'));
		const label = new HighlightedLabel(name, false);

		return { name, label };
	}

	renderElement(element: ITreeNode<IScope, FuzzyScore>, index: number, templateData: IScopeTemplateData): void {
		templateData.label.set(element.element.name, createMatches(element.filterData));
	}

	disposeTemplate(templateData: IScopeTemplateData): void {
		// noop
	}
}

export class VariablesRenderer extends AbstractExpressionsRenderer {

	static readonly ID = 'variable';

	get templateId(): string {
		return VariablesRenderer.ID;
	}

	protected renderExpression(expression: IExpression, data: IExpressionTemplateData, highlights: IHighlight[]): void {
		renderVariable(expression as Variable, data, true, highlights);
	}

	protected getInputBoxOptions(expression: IExpression): IInputBoxOptions {
		const variable = <Variable>expression;
		return {
			initialValue: expression.value,
			ariaLabel: nls.localize('variableValueAriaLabel', "Type new variable value"),
			validationOptions: {
				validation: () => variable.errorMessage ? ({ content: variable.errorMessage }) : null
			},
			onFinish: (value: string, success: boolean) => {
				variable.errorMessage = undefined;
				if (success && variable.value !== value) {
					variable.setVariable(value)
						// Need to force watch expressions and variables to update since a variable change can have an effect on both
						.then(() => variableSetEmitter.fire());
				}
			}
		};
	}
}

class VariablesAccessibilityProvider implements IAccessibilityProvider<IExpression | IScope> {
	getAriaLabel(element: IExpression | IScope): string | null {
		if (element instanceof Scope) {
			return nls.localize('variableScopeAriaLabel', "Scope {0}, variables, debug", element.name);
		}
		if (element instanceof Variable) {
			return nls.localize('variableAriaLabel', "{0} value {1}, variables, debug", element.name, element.value);
		}

		return null;
	}
}
