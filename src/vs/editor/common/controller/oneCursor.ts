/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { SingleCursorState, CursorConfiguration, ICursorSimpleModel, CursorState } from 'vs/editor/common/controller/cursorCommon';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { Selection, SelectionDirection } from 'vs/editor/common/core/selection';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { MoveOperations } from 'vs/editor/common/controller/cursorMoveOperations';
import { WordOperations } from 'vs/editor/common/controller/cursorWordOperations';
import { ICoordinatesConverter } from 'vs/editor/common/viewModel/viewModel';

export interface CursorMoveArguments extends editorCommon.CursorMoveArguments {
	pageSize?: number;
	isPaged?: boolean;
}

export interface IViewModelHelper {

	coordinatesConverter: ICoordinatesConverter;

	viewModel: ICursorSimpleModel;

	getCompletelyVisibleViewRange(): Range;
}

export class CursorContext {
	_cursorContextBrand: void;

	public readonly model: editorCommon.IModel;
	public readonly viewModel: ICursorSimpleModel;
	public readonly config: CursorConfiguration;

	private readonly _viewModelHelper: IViewModelHelper;
	private readonly _coordinatesConverter: ICoordinatesConverter;

	constructor(model: editorCommon.IModel, viewModelHelper: IViewModelHelper, config: CursorConfiguration) {
		this.model = model;
		this.viewModel = viewModelHelper.viewModel;
		this.config = config;
		this._viewModelHelper = viewModelHelper;
		this._coordinatesConverter = viewModelHelper.coordinatesConverter;
	}

	public validateModelPosition(position: editorCommon.IPosition): Position {
		return this.model.validatePosition(position);
	}

	public validateViewPosition(viewPosition: Position, modelPosition: Position): Position {
		return this._coordinatesConverter.validateViewPosition(viewPosition, modelPosition);
	}

	public validateViewRange(viewRange: Range, expectedModelRange: Range): Range {
		return this._coordinatesConverter.validateViewRange(viewRange, expectedModelRange);
	}

	public convertViewSelectionToModelSelection(viewSelection: Selection): Selection {
		return this._coordinatesConverter.convertViewSelectionToModelSelection(viewSelection);
	}

	public convertViewPositionToModelPosition(lineNumber: number, column: number): Position {
		return this._coordinatesConverter.convertViewPositionToModelPosition(new Position(lineNumber, column));
	}

	public convertModelPositionToViewPosition(modelPosition: Position): Position {
		return this._coordinatesConverter.convertModelPositionToViewPosition(modelPosition);
	}

	public convertModelRangeToViewRange(modelRange: Range): Range {
		return this._coordinatesConverter.convertModelRangeToViewRange(modelRange);
	}

	public getCompletelyVisibleViewRange(): Range {
		return this._viewModelHelper.getCompletelyVisibleViewRange();
	}

	public getCompletelyVisibleModelRange(): Range {
		const viewRange = this._viewModelHelper.getCompletelyVisibleViewRange();
		return this._coordinatesConverter.convertViewRangeToModelRange(viewRange);
	}

	public getRangeToRevealModelLinesBeforeViewPortTop(noOfLinesBeforeTop: number): Range {
		let visibleModelRange = this.getCompletelyVisibleModelRange();

		let startLineNumber: number;
		if (this.model.getLineMinColumn(visibleModelRange.startLineNumber) !== visibleModelRange.startColumn) {
			// Start line is partially visible by wrapping so reveal start line
			startLineNumber = visibleModelRange.startLineNumber;
		} else {
			// Reveal previous line
			startLineNumber = visibleModelRange.startLineNumber - 1;
		}

		startLineNumber -= (noOfLinesBeforeTop - 1);
		startLineNumber = this.model.validateRange({ startLineNumber, startColumn: 1, endLineNumber: startLineNumber, endColumn: 1 }).startLineNumber;
		let startColumn = this.model.getLineMinColumn(startLineNumber);
		let endColumn = this.model.getLineMaxColumn(visibleModelRange.startLineNumber);

		return new Range(startLineNumber, startColumn, startLineNumber, endColumn);
	}

	public getRangeToRevealModelLinesAfterViewPortBottom(noOfLinesAfterBottom: number): Range {
		let visibleModelRange = this.getCompletelyVisibleModelRange();

		// Last line in the view port is not considered revealed because scroll bar would cover it
		// Hence consider last line to reveal in the range
		let startLineNumber = visibleModelRange.endLineNumber + (noOfLinesAfterBottom - 1);
		startLineNumber = this.model.validateRange({ startLineNumber, startColumn: 1, endLineNumber: startLineNumber, endColumn: 1 }).startLineNumber;
		let startColumn = this.model.getLineMinColumn(startLineNumber);
		let endColumn = this.model.getLineMaxColumn(startLineNumber);

		return new Range(startLineNumber, startColumn, startLineNumber, endColumn);
	}

	public isLastLineVisibleInViewPort(): boolean {
		return this.viewModel.getLineCount() <= this.getCompletelyVisibleViewRange().getEndPosition().lineNumber;
	}
}

export interface IOneCursorState {
	selectionStart: Range;
	viewSelectionStart: Range;
	position: Position;
	viewPosition: Position;
	leftoverVisibleColumns: number;
	selectionStartLeftoverVisibleColumns: number;
}

export class OneCursor {

	public modelState: SingleCursorState;
	public viewState: SingleCursorState;

	private _selStartMarker: string;
	private _selEndMarker: string;

	constructor(context: CursorContext) {
		this._setState(
			context,
			new SingleCursorState(new Range(1, 1, 1, 1), 0, new Position(1, 1), 0),
			new SingleCursorState(new Range(1, 1, 1, 1), 0, new Position(1, 1), 0),
			false
		);
	}

	/**
	 * Sometimes, the line mapping changes and the stored view position is stale.
	 */
	public ensureValidState(context: CursorContext): void {
		this._setState(context, this.modelState, this.viewState, false);
	}

	private _ensureInEditableRange(context: CursorContext, position: Position): Position {
		let editableRange = context.model.getEditableRange();

		if (position.lineNumber < editableRange.startLineNumber || (position.lineNumber === editableRange.startLineNumber && position.column < editableRange.startColumn)) {
			return new Position(editableRange.startLineNumber, editableRange.startColumn);
		} else if (position.lineNumber > editableRange.endLineNumber || (position.lineNumber === editableRange.endLineNumber && position.column > editableRange.endColumn)) {
			return new Position(editableRange.endLineNumber, editableRange.endColumn);
		}
		return position;
	}

	private _setState(context: CursorContext, modelState: SingleCursorState, viewState: SingleCursorState, ensureInEditableRange: boolean): void {
		// Validate new model state
		let selectionStart = context.model.validateRange(modelState.selectionStart);
		let selectionStartLeftoverVisibleColumns = modelState.selectionStart.equalsRange(selectionStart) ? modelState.selectionStartLeftoverVisibleColumns : 0;

		let position = context.model.validatePosition(modelState.position);
		if (ensureInEditableRange) {
			position = this._ensureInEditableRange(context, position);
		}
		let leftoverVisibleColumns = modelState.position.equals(position) ? modelState.leftoverVisibleColumns : 0;

		modelState = new SingleCursorState(selectionStart, selectionStartLeftoverVisibleColumns, position, leftoverVisibleColumns);

		// Validate new view state
		let viewSelectionStart = context.validateViewRange(viewState.selectionStart, modelState.selectionStart);
		let viewPosition = context.validateViewPosition(viewState.position, modelState.position);
		viewState = new SingleCursorState(viewSelectionStart, selectionStartLeftoverVisibleColumns, viewPosition, leftoverVisibleColumns);

		if (this.modelState && this.viewState && this.modelState.equals(modelState) && this.viewState.equals(viewState)) {
			// No-op, early return
			return;
		}

		this.modelState = modelState;
		this.viewState = viewState;

		this._selStartMarker = this._ensureMarker(context, this._selStartMarker, this.modelState.selection.startLineNumber, this.modelState.selection.startColumn, true);
		this._selEndMarker = this._ensureMarker(context, this._selEndMarker, this.modelState.selection.endLineNumber, this.modelState.selection.endColumn, false);
	}

	private _ensureMarker(context: CursorContext, markerId: string, lineNumber: number, column: number, stickToPreviousCharacter: boolean): string {
		if (!markerId) {
			return context.model._addMarker(0, lineNumber, column, stickToPreviousCharacter);
		} else {
			context.model._changeMarker(markerId, lineNumber, column);
			context.model._changeMarkerStickiness(markerId, stickToPreviousCharacter);
			return markerId;
		}
	}

	public saveState(): IOneCursorState {
		return {
			selectionStart: this.modelState.selectionStart,
			viewSelectionStart: this.viewState.selectionStart,
			position: this.modelState.position,
			viewPosition: this.viewState.position,
			leftoverVisibleColumns: this.modelState.leftoverVisibleColumns,
			selectionStartLeftoverVisibleColumns: this.modelState.selectionStartLeftoverVisibleColumns
		};
	}

	public restoreState(context: CursorContext, state: IOneCursorState): void {
		let position = context.model.validatePosition(state.position);
		let selectionStart: Range;
		if (state.selectionStart) {
			selectionStart = context.model.validateRange(state.selectionStart);
		} else {
			selectionStart = new Range(position.lineNumber, position.column, position.lineNumber, position.column);
		}

		let viewPosition = context.validateViewPosition(new Position(state.viewPosition.lineNumber, state.viewPosition.column), position);
		let viewSelectionStart: Range;
		if (state.viewSelectionStart) {
			viewSelectionStart = context.validateViewRange(new Range(state.viewSelectionStart.startLineNumber, state.viewSelectionStart.startColumn, state.viewSelectionStart.endLineNumber, state.viewSelectionStart.endColumn), selectionStart);
		} else {
			viewSelectionStart = context.convertModelRangeToViewRange(selectionStart);
		}

		this._setState(
			context,
			new SingleCursorState(selectionStart, state.selectionStartLeftoverVisibleColumns, position, state.leftoverVisibleColumns),
			new SingleCursorState(viewSelectionStart, state.selectionStartLeftoverVisibleColumns, viewPosition, state.leftoverVisibleColumns),
			false
		);
	}

	public dispose(context: CursorContext): void {
		context.model._removeMarker(this._selStartMarker);
		context.model._removeMarker(this._selEndMarker);
	}

	public setSelection(context: CursorContext, selection: editorCommon.ISelection, viewSelection: editorCommon.ISelection = null): void {
		let position = context.model.validatePosition({
			lineNumber: selection.positionLineNumber,
			column: selection.positionColumn
		});
		let selectionStart = context.model.validatePosition({
			lineNumber: selection.selectionStartLineNumber,
			column: selection.selectionStartColumn
		});

		let viewPosition: Position;
		let viewSelectionStart: Position;

		if (viewSelection) {
			viewPosition = context.validateViewPosition(new Position(viewSelection.positionLineNumber, viewSelection.positionColumn), position);
			viewSelectionStart = context.validateViewPosition(new Position(viewSelection.selectionStartLineNumber, viewSelection.selectionStartColumn), selectionStart);
		} else {
			viewPosition = context.convertModelPositionToViewPosition(position);
			viewSelectionStart = context.convertModelPositionToViewPosition(selectionStart);
		}

		this._setState(
			context,
			new SingleCursorState(new Range(selectionStart.lineNumber, selectionStart.column, selectionStart.lineNumber, selectionStart.column), 0, position, 0),
			new SingleCursorState(new Range(viewSelectionStart.lineNumber, viewSelectionStart.column, viewSelectionStart.lineNumber, viewSelectionStart.column), 0, viewPosition, 0),
			false
		);
	}

	// -------------------- START modifications

	public setState(context: CursorContext, modelState: SingleCursorState, viewState: SingleCursorState, ensureInEditableRange: boolean): void {
		this._setState(context, modelState, viewState, ensureInEditableRange);
	}

	public beginRecoverSelectionFromMarkers(context: CursorContext): Selection {
		const start = context.model._getMarker(this._selStartMarker);
		const end = context.model._getMarker(this._selEndMarker);

		if (this.modelState.selection.getDirection() === SelectionDirection.LTR) {
			return new Selection(start.lineNumber, start.column, end.lineNumber, end.column);
		}

		return new Selection(end.lineNumber, end.column, start.lineNumber, start.column);
	}

	public endRecoverSelectionFromMarkers(context: CursorContext, recoveredSelection: Selection): boolean {

		const selectionStart = new Range(recoveredSelection.selectionStartLineNumber, recoveredSelection.selectionStartColumn, recoveredSelection.selectionStartLineNumber, recoveredSelection.selectionStartColumn);
		const position = new Position(recoveredSelection.positionLineNumber, recoveredSelection.positionColumn);

		const viewSelectionStart = context.convertModelRangeToViewRange(selectionStart);
		const viewPosition = context.convertModelPositionToViewPosition(position);

		this._setState(
			context,
			new SingleCursorState(selectionStart, 0, position, 0),
			new SingleCursorState(viewSelectionStart, 0, viewPosition, 0),
			false
		);

		return true;
	}

	// -------------------- END modifications
}

export class OneCursorOp {

	// -------------------- START handlers that simply change cursor state

	public static moveTo(context: CursorContext, cursor: OneCursor, inSelectionMode: boolean, _position: editorCommon.IPosition, _viewPosition: editorCommon.IPosition): CursorState {
		const position = context.validateModelPosition(_position);
		const viewPosition = (
			_viewPosition
				? context.validateViewPosition(new Position(_viewPosition.lineNumber, _viewPosition.column), position)
				: context.convertModelPositionToViewPosition(position)
		);
		return this._fromViewCursorState(context, cursor, cursor.viewState.move(inSelectionMode, viewPosition.lineNumber, viewPosition.column, 0));
	}

	public static move(context: CursorContext, cursors: OneCursor[], moveParams: CursorMoveArguments): CursorState[] {
		if (!moveParams.to) {
			return null;
		}

		const inSelectionMode = !!moveParams.select;
		switch (moveParams.to) {
			case editorCommon.CursorMovePosition.Left: {
				if (moveParams.by === editorCommon.CursorMoveByUnit.HalfLine) {
					// Move left by half the current line length
					return this._moveHalfLineLeft(context, cursors, inSelectionMode);
				} else {
					// Move left by `moveParams.value` columns
					return this._moveLeft(context, cursors, inSelectionMode, moveParams.value);
				}
			}
			case editorCommon.CursorMovePosition.Right: {
				if (moveParams.by === editorCommon.CursorMoveByUnit.HalfLine) {
					// Move right by half the current line length
					return this._moveHalfLineRight(context, cursors, inSelectionMode);
				} else {
					// Move right by `moveParams.value` columns
					return this._moveRight(context, cursors, inSelectionMode, moveParams.value);
				}
			}
			case editorCommon.CursorMovePosition.Up: {
				const linesCount = (moveParams.isPaged ? (moveParams.pageSize || context.config.pageSize) : moveParams.value) || 1;
				if (moveParams.by === editorCommon.CursorMoveByUnit.WrappedLine) {
					// Move up by `linesCount` view lines
					return this._moveUpByViewLines(context, cursors, inSelectionMode, linesCount);
				} else {
					// Move up by `linesCount` model lines
					return this._moveUpByModelLines(context, cursors, inSelectionMode, linesCount);
				}
			}
			case editorCommon.CursorMovePosition.Down: {
				const linesCount = (moveParams.isPaged ? (moveParams.pageSize || context.config.pageSize) : moveParams.value) || 1;
				if (editorCommon.CursorMoveByUnit.WrappedLine === moveParams.by) {
					// Move down by `linesCount` view lines
					return this._moveDownByViewLines(context, cursors, inSelectionMode, linesCount);
				} else {
					// Move down by `linesCount` model lines
					return this._moveDownByModelLines(context, cursors, inSelectionMode, linesCount);
				}
			}
			case editorCommon.CursorMovePosition.WrappedLineStart: {
				// Move to the beginning of the current view line
				return this._moveToViewMinColumn(context, cursors, inSelectionMode);
			}
			case editorCommon.CursorMovePosition.WrappedLineFirstNonWhitespaceCharacter: {
				// Move to the first non-whitespace column of the current view line
				return this._moveToViewFirstNonWhitespaceColumn(context, cursors, inSelectionMode);
			}
			case editorCommon.CursorMovePosition.WrappedLineColumnCenter: {
				// Move to the "center" of the current view line
				return this._moveToViewCenterColumn(context, cursors, inSelectionMode);
			}
			case editorCommon.CursorMovePosition.WrappedLineEnd: {
				// Move to the end of the current view line
				return this._moveToViewMaxColumn(context, cursors, inSelectionMode);
			}
			case editorCommon.CursorMovePosition.WrappedLineLastNonWhitespaceCharacter: {
				// Move to the last non-whitespace column of the current view line
				return this._moveToViewLastNonWhitespaceColumn(context, cursors, inSelectionMode);
			}
			case editorCommon.CursorMovePosition.ViewPortTop: {
				// Move to the nth line start in the viewport (from the top)
				const cnt = (moveParams.value || 1);
				const cursor = cursors[0];
				const visibleModelRange = context.getCompletelyVisibleModelRange();
				const modelLineNumber = this._firstLineNumberInRange(context.model, visibleModelRange, cnt);
				const modelColumn = context.model.getLineFirstNonWhitespaceColumn(modelLineNumber);
				return [this._moveToModelPosition(context, cursor, inSelectionMode, modelLineNumber, modelColumn)];
			}
			case editorCommon.CursorMovePosition.ViewPortBottom: {
				// Move to the nth line start in the viewport (from the bottom)
				const cnt = (moveParams.value || 1);
				const cursor = cursors[0];
				const visibleModelRange = context.getCompletelyVisibleModelRange();
				const modelLineNumber = this._lastLineNumberInRange(context.model, visibleModelRange, cnt);
				const modelColumn = context.model.getLineFirstNonWhitespaceColumn(modelLineNumber);
				return [this._moveToModelPosition(context, cursor, inSelectionMode, modelLineNumber, modelColumn)];
			}
			case editorCommon.CursorMovePosition.ViewPortCenter: {
				// Move to the line start in the viewport center
				const cursor = cursors[0];
				const visibleModelRange = context.getCompletelyVisibleModelRange();
				const modelLineNumber = Math.round((visibleModelRange.startLineNumber + visibleModelRange.endLineNumber) / 2);
				const modelColumn = context.model.getLineFirstNonWhitespaceColumn(modelLineNumber);
				return [this._moveToModelPosition(context, cursor, inSelectionMode, modelLineNumber, modelColumn)];
			}
			case editorCommon.CursorMovePosition.ViewPortIfOutside: {
				// Move to a position inside the viewport
				const visibleViewRange = context.getCompletelyVisibleViewRange();
				let result: CursorState[] = [];
				for (let i = 0, len = cursors.length; i < len; i++) {
					const cursor = cursors[i];
					let viewLineNumber = cursor.viewState.position.lineNumber;

					if (visibleViewRange.startLineNumber <= viewLineNumber && viewLineNumber <= visibleViewRange.endLineNumber) {
						// Nothing to do, cursor is in viewport
						result[i] = new CursorState(cursor.modelState, cursor.viewState);

					} else {
						if (viewLineNumber > visibleViewRange.endLineNumber) {
							viewLineNumber = visibleViewRange.endLineNumber - 1;
						}
						if (viewLineNumber < visibleViewRange.startLineNumber) {
							viewLineNumber = visibleViewRange.startLineNumber;
						}
						const viewColumn = context.viewModel.getLineFirstNonWhitespaceColumn(viewLineNumber);
						result[i] = this._moveToViewPosition(context, cursor, inSelectionMode, viewLineNumber, viewColumn);
					}
				}
				return result;
			}
		}

		return null;
	}

	/**
	 * Find the nth line start included in the range (from the start).
	 */
	private static _firstLineNumberInRange(model: ICursorSimpleModel, range: Range, count: number): number {
		let startLineNumber = range.startLineNumber;
		if (range.startColumn !== model.getLineMinColumn(startLineNumber)) {
			// Move on to the second line if the first line start is not included in the range
			startLineNumber++;
		}

		return Math.min(range.endLineNumber, startLineNumber + count - 1);
	}

	/**
	 * Find the nth line start included in the range (from the end).
	 */
	private static _lastLineNumberInRange(model: ICursorSimpleModel, range: Range, count: number): number {
		let startLineNumber = range.startLineNumber;
		if (range.startColumn !== model.getLineMinColumn(startLineNumber)) {
			// Move on to the second line if the first line start is not included in the range
			startLineNumber++;
		}

		return Math.max(startLineNumber, range.endLineNumber - count + 1);
	}

	private static _fromModelCursorState(context: CursorContext, cursor: OneCursor, modelState: SingleCursorState): CursorState {
		let viewSelectionStart1 = context.convertModelPositionToViewPosition(new Position(modelState.selectionStart.startLineNumber, modelState.selectionStart.startColumn));
		let viewSelectionStart2 = context.convertModelPositionToViewPosition(new Position(modelState.selectionStart.endLineNumber, modelState.selectionStart.endColumn));
		let viewSelectionStart = new Range(viewSelectionStart1.lineNumber, viewSelectionStart1.column, viewSelectionStart2.lineNumber, viewSelectionStart2.column);
		let viewPosition = context.convertModelPositionToViewPosition(modelState.position);
		return new CursorState(
			modelState,
			new SingleCursorState(viewSelectionStart, modelState.selectionStartLeftoverVisibleColumns, viewPosition, modelState.leftoverVisibleColumns)
		);
	}

	private static _fromViewCursorState(context: CursorContext, cursor: OneCursor, viewState: SingleCursorState): CursorState {
		let selectionStart1 = context.convertViewPositionToModelPosition(viewState.selectionStart.startLineNumber, viewState.selectionStart.startColumn);
		let selectionStart2 = context.convertViewPositionToModelPosition(viewState.selectionStart.endLineNumber, viewState.selectionStart.endColumn);
		let selectionStart = new Range(selectionStart1.lineNumber, selectionStart1.column, selectionStart2.lineNumber, selectionStart2.column);
		let position = context.convertViewPositionToModelPosition(viewState.position.lineNumber, viewState.position.column);
		return new CursorState(
			new SingleCursorState(selectionStart, viewState.selectionStartLeftoverVisibleColumns, position, viewState.leftoverVisibleColumns),
			viewState
		);
	}

	private static _moveLeft(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean, noOfColumns: number = 1): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			result[i] = this._fromViewCursorState(context, cursor, MoveOperations.moveLeft(context.config, context.viewModel, cursor.viewState, inSelectionMode, noOfColumns));
		}
		return result;
	}

	private static _moveHalfLineLeft(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			const viewLineNumber = cursor.viewState.position.lineNumber;
			const halfLine = Math.round(context.viewModel.getLineContent(viewLineNumber).length / 2);
			result[i] = this._fromViewCursorState(context, cursor, MoveOperations.moveLeft(context.config, context.viewModel, cursor.viewState, inSelectionMode, halfLine));
		}
		return result;
	}

	private static _moveRight(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean, noOfColumns: number = 1): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			result[i] = this._fromViewCursorState(context, cursor, MoveOperations.moveRight(context.config, context.viewModel, cursor.viewState, inSelectionMode, noOfColumns));
		}
		return result;
	}

	private static _moveHalfLineRight(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			const viewLineNumber = cursor.viewState.position.lineNumber;
			const halfLine = Math.round(context.viewModel.getLineContent(viewLineNumber).length / 2);
			result[i] = this._fromViewCursorState(context, cursor, MoveOperations.moveRight(context.config, context.viewModel, cursor.viewState, inSelectionMode, halfLine));
		}
		return result;
	}

<<<<<<< HEAD
	private static _moveDownByViewLines(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean, linesCount: number): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			result[i] = this._fromViewCursorState(context, cursor, MoveOperations.moveDown(context.config, context.viewModel, cursor.viewState, inSelectionMode, linesCount));
		}
		return result;
	}

	private static _moveDownByModelLines(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean, linesCount: number): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			result[i] = this._fromModelCursorState(context, cursor, MoveOperations.moveDown(context.config, context.model, cursor.modelState, inSelectionMode, linesCount));
		}
		return result;
=======
	// -- model
	public getLineContent(lineNumber:number): string {
		return this.model.getLineContent(lineNumber);
	}
	public findPreviousWordOnLine(position:Position): IFindWordResult {
		return this.helper.findPreviousWordOnLine(position);
	}
	public findNextWordOnLine(position:Position): IFindWordResult {
		return this.helper.findNextWordOnLine(position);
	}
	public getLeftOfPosition(lineNumber:number, column:number): editorCommon.IPosition {
		return this.helper.getLeftOfPosition(this.model, lineNumber, column);
	}
	public getRightOfPosition(lineNumber:number, column:number): editorCommon.IPosition {
		return this.helper.getRightOfPosition(this.model, lineNumber, column);
	}
	public getPositionUp(lineNumber:number, column:number, leftoverVisibleColumns:number, count:number, allowMoveOnFirstLine:boolean): IMoveResult {
		return this.helper.getPositionUp(this.model, lineNumber, column, leftoverVisibleColumns, count, allowMoveOnFirstLine);
	}
	public getPositionDown(lineNumber:number, column:number, leftoverVisibleColumns:number, count:number, allowMoveOnLastLine:boolean): IMoveResult {
		return this.helper.getPositionDown(this.model, lineNumber, column, leftoverVisibleColumns, count, allowMoveOnLastLine);
	}
	public getColumnAtEndOfLine(lineNumber:number, column:number): number {
		return this.helper.getColumnAtEndOfLine(this.model, lineNumber, column);
	}
	public getVisibleColumnFromColumn(lineNumber:number, column:number): number {
		return this.helper.visibleColumnFromColumn(this.model, lineNumber, column);
	}
	public getColumnFromVisibleColumn(lineNumber:number, column:number): number {
		return this.helper.columnFromVisibleColumn(this.model, lineNumber, column);
	}
	public getViewVisibleColumnFromColumn(viewLineNumber:number, viewColumn:number): number {
		return this.helper.visibleColumnFromColumn(this.viewModelHelper.viewModel, viewLineNumber, viewColumn);
	}

	// -- view
	public getViewLineCount(): number {
		return this.viewModelHelper.viewModel.getLineCount();
	}
	public getViewLineMinColumn(lineNumber:number): number {
		return this.viewModelHelper.viewModel.getLineMinColumn(lineNumber);
	}
	public getViewLineMaxColumn(lineNumber:number): number {
		return this.viewModelHelper.viewModel.getLineMaxColumn(lineNumber);
	}
	public getLeftOfViewPosition(lineNumber:number, column:number): editorCommon.IPosition {
		return this.helper.getLeftOfPosition(this.viewModelHelper.viewModel, lineNumber, column);
	}
	public getRightOfViewPosition(lineNumber:number, column:number): editorCommon.IPosition {
		return this.helper.getRightOfPosition(this.viewModelHelper.viewModel, lineNumber, column);
	}
	public getViewPositionUp(lineNumber:number, column:number, leftoverVisibleColumns:number, count:number, allowMoveOnFirstLine:boolean): IMoveResult {
		return this.helper.getPositionUp(this.viewModelHelper.viewModel, lineNumber, column, leftoverVisibleColumns, count, allowMoveOnFirstLine);
	}
	public getViewPositionDown(lineNumber:number, column:number, leftoverVisibleColumns:number, count:number, allowMoveOnLastLine:boolean): IMoveResult {
		return this.helper.getPositionDown(this.viewModelHelper.viewModel, lineNumber, column, leftoverVisibleColumns, count, allowMoveOnLastLine);
	}
	public getColumnAtBeginningOfViewLine(lineNumber:number, column:number): number {
		return this.helper.getColumnAtBeginningOfLine(this.viewModelHelper.viewModel, lineNumber, column);
	}
	public getColumnAtEndOfViewLine(lineNumber:number, column:number): number {
		return this.helper.getColumnAtEndOfLine(this.viewModelHelper.viewModel, lineNumber, column);
	}
	public columnSelect(fromViewLineNumber:number, fromViewVisibleColumn:number, toViewLineNumber:number, toViewVisibleColumn:number): IColumnSelectResult {
		let r = this.helper.columnSelect(this.viewModelHelper.viewModel, fromViewLineNumber, fromViewVisibleColumn, toViewLineNumber, toViewVisibleColumn);
		return {
			reversed: r.reversed,
			viewSelections: r.viewSelections,
			selections: r.viewSelections.map(sel => this.convertViewSelectionToModelSelection(sel)),
			toLineNumber: toViewLineNumber,
			toVisualColumn: toViewVisibleColumn
		};
>>>>>>> origin/alex/cursorHardHome
	}

	private static _moveUpByViewLines(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean, linesCount: number): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			result[i] = this._fromViewCursorState(context, cursor, MoveOperations.moveUp(context.config, context.viewModel, cursor.viewState, inSelectionMode, linesCount));
		}
		return result;
	}

	private static _moveUpByModelLines(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean, linesCount: number): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			result[i] = this._fromModelCursorState(context, cursor, MoveOperations.moveUp(context.config, context.model, cursor.modelState, inSelectionMode, linesCount));
		}
		return result;
	}

	private static _moveToViewPosition(context: CursorContext, cursor: OneCursor, inSelectionMode: boolean, toViewLineNumber: number, toViewColumn: number): CursorState {
		return this._fromViewCursorState(context, cursor, cursor.viewState.move(inSelectionMode, toViewLineNumber, toViewColumn, 0));
	}

	private static _moveToModelPosition(context: CursorContext, cursor: OneCursor, inSelectionMode: boolean, toModelLineNumber: number, toModelColumn: number): CursorState {
		return this._fromModelCursorState(context, cursor, cursor.modelState.move(inSelectionMode, toModelLineNumber, toModelColumn, 0));
	}

	private static _moveToViewMinColumn(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			const viewLineNumber = cursor.viewState.position.lineNumber;
			const viewColumn = context.viewModel.getLineMinColumn(viewLineNumber);
			result[i] = this._moveToViewPosition(context, cursor, inSelectionMode, viewLineNumber, viewColumn);
		}
		return result;
	}

	private static _moveToViewFirstNonWhitespaceColumn(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			const viewLineNumber = cursor.viewState.position.lineNumber;
			const viewColumn = context.viewModel.getLineFirstNonWhitespaceColumn(viewLineNumber);
			result[i] = this._moveToViewPosition(context, cursor, inSelectionMode, viewLineNumber, viewColumn);
		}
		return result;
	}

	private static _moveToViewCenterColumn(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			const viewLineNumber = cursor.viewState.position.lineNumber;
			const viewColumn = Math.round((context.viewModel.getLineMaxColumn(viewLineNumber) + context.viewModel.getLineMinColumn(viewLineNumber)) / 2);
			result[i] = this._moveToViewPosition(context, cursor, inSelectionMode, viewLineNumber, viewColumn);
		}
		return result;
	}

	private static _moveToViewMaxColumn(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			const viewLineNumber = cursor.viewState.position.lineNumber;
			const viewColumn = context.viewModel.getLineMaxColumn(viewLineNumber);
			result[i] = this._moveToViewPosition(context, cursor, inSelectionMode, viewLineNumber, viewColumn);
		}
		return result;
	}

	private static _moveToViewLastNonWhitespaceColumn(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			const viewLineNumber = cursor.viewState.position.lineNumber;
			const viewColumn = context.viewModel.getLineLastNonWhitespaceColumn(viewLineNumber);
			result[i] = this._moveToViewPosition(context, cursor, inSelectionMode, viewLineNumber, viewColumn);
		}
		return result;
	}

	public static addCursorDown(context: CursorContext, cursors: OneCursor[]): CursorState[] {
		let result: CursorState[] = [], resultLen = 0;
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			result[resultLen++] = new CursorState(cursor.modelState, cursor.viewState);
			result[resultLen++] = this._fromViewCursorState(context, cursor, MoveOperations.translateDown(context.config, context.viewModel, cursor.viewState));
		}
		return result;
	}

	public static addCursorUp(context: CursorContext, cursors: OneCursor[]): CursorState[] {
		let result: CursorState[] = [], resultLen = 0;
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			result[resultLen++] = new CursorState(cursor.modelState, cursor.viewState);
			result[resultLen++] = this._fromViewCursorState(context, cursor, MoveOperations.translateUp(context.config, context.viewModel, cursor.viewState));
		}
		return result;
	}

	public static moveToBeginningOfLine(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			result[i] = this._fromViewCursorState(context, cursor, MoveOperations.moveToBeginningOfLine(context.config, context.viewModel, cursor.viewState, inSelectionMode));
		}
		return result;
	}

	public static moveToEndOfLine(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			result[i] = this._fromViewCursorState(context, cursor, MoveOperations.moveToEndOfLine(context.config, context.viewModel, cursor.viewState, inSelectionMode));
		}
		return result;
	}

	public static expandLineSelection(context: CursorContext, cursors: OneCursor[]): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];

			const viewSelection = cursor.viewState.selection;
			const startLineNumber = viewSelection.startLineNumber;
			const lineCount = context.viewModel.getLineCount();

			let endLineNumber = viewSelection.endLineNumber;
			let endColumn: number;
			if (endLineNumber === lineCount) {
				endColumn = context.viewModel.getLineMaxColumn(lineCount);
			} else {
				endLineNumber++;
				endColumn = 1;
			}

			result[i] = this._fromViewCursorState(context, cursor, new SingleCursorState(
				new Range(startLineNumber, 1, startLineNumber, 1), 0,
				new Position(endLineNumber, endColumn), 0
			));
		}
		return result;
	}

	public static moveToBeginningOfBuffer(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			result[i] = this._fromModelCursorState(context, cursor, MoveOperations.moveToBeginningOfBuffer(context.config, context.model, cursor.modelState, inSelectionMode));
		}
		return result;
	}

	public static moveToEndOfBuffer(context: CursorContext, cursors: OneCursor[], inSelectionMode: boolean): CursorState[] {
		let result: CursorState[] = [];
		for (let i = 0, len = cursors.length; i < len; i++) {
			const cursor = cursors[i];
			result[i] = this._fromModelCursorState(context, cursor, MoveOperations.moveToEndOfBuffer(context.config, context.model, cursor.modelState, inSelectionMode));
		}
		return result;
	}

	public static selectAll(context: CursorContext, cursor: OneCursor): CursorState {

		if (context.model.hasEditableRange()) {
			// Toggle between selecting editable range and selecting the entire buffer

			const editableRange = context.model.getEditableRange();
			const selection = cursor.modelState.selection;

			if (!selection.equalsRange(editableRange)) {
				// Selection is not editable range => select editable range
				return this._fromModelCursorState(context, cursor, new SingleCursorState(
					new Range(editableRange.startLineNumber, editableRange.startColumn, editableRange.startLineNumber, editableRange.startColumn), 0,
					new Position(editableRange.endLineNumber, editableRange.endColumn), 0
				));
			}
		}

		const lineCount = context.model.getLineCount();
		const maxColumn = context.model.getLineMaxColumn(lineCount);

		return this._fromModelCursorState(context, cursor, new SingleCursorState(
			new Range(1, 1, 1, 1), 0,
			new Position(lineCount, maxColumn), 0
		));
	}

	public static line(context: CursorContext, cursor: OneCursor, inSelectionMode: boolean, _position: editorCommon.IPosition, _viewPosition: editorCommon.IPosition): CursorState {
		const position = context.validateModelPosition(_position);
		const viewPosition = (
			_viewPosition
				? context.validateViewPosition(new Position(_viewPosition.lineNumber, _viewPosition.column), position)
				: context.convertModelPositionToViewPosition(position)
		);

		if (!inSelectionMode || !cursor.modelState.hasSelection()) {
			// Entering line selection for the first time
			const lineCount = context.model.getLineCount();

			let selectToLineNumber = position.lineNumber + 1;
			let selectToColumn = 1;
			if (selectToLineNumber > lineCount) {
				selectToLineNumber = lineCount;
				selectToColumn = context.model.getLineMaxColumn(selectToLineNumber);
			}

			return this._fromModelCursorState(context, cursor, new SingleCursorState(
				new Range(position.lineNumber, 1, selectToLineNumber, selectToColumn), 0,
				new Position(selectToLineNumber, selectToColumn), 0
			));
		}

		// Continuing line selection
		const enteringLineNumber = cursor.modelState.selectionStart.getStartPosition().lineNumber;

		if (position.lineNumber < enteringLineNumber) {

<<<<<<< HEAD
			return this._fromViewCursorState(context, cursor, cursor.viewState.move(
				cursor.modelState.hasSelection(), viewPosition.lineNumber, 1, 0
			));
=======
		if (column === cursor.model.getLineMaxColumn(lineNumber)) {
			if (lineNumber < cursor.model.getLineCount()) {
				lineNumber = lineNumber + 1;
				column = 1;
			}
		}

		let nextWordOnLine = cursor.findNextWordOnLine(new Position(lineNumber, column));

		if (wordNavigationType === WordNavigationType.WordEnd) {
			if (nextWordOnLine) {
				column = nextWordOnLine.end + 1;
			} else {
				column = cursor.model.getLineMaxColumn(lineNumber);
			}
		} else {
			if (nextWordOnLine && column >= nextWordOnLine.start + 1) {
				nextWordOnLine = cursor.findNextWordOnLine(new Position(lineNumber, nextWordOnLine.end + 1));
			}
			if (nextWordOnLine) {
				column = nextWordOnLine.start + 1;
			} else {
				column = cursor.model.getLineMaxColumn(lineNumber);
			}
		}

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveModelPosition(inSelectionMode, lineNumber, column, 0, true);
		return true;
	}

	public static moveDown(cursor:OneCursor, inSelectionMode: boolean, isPaged: boolean, usePageSize: number, ctx: IOneCursorOperationContext): boolean {
		let linesCount = isPaged ? (usePageSize || cursor.getPageSize()) : 1;

		let viewLineNumber:number,
			viewColumn:number;

		if (cursor.hasSelection() && !inSelectionMode) {
			// If we are in selection mode, move down acts relative to the end of selection
			let viewSelection = cursor.getViewSelection();
			let viewSelectionEnd = cursor.validateViewPosition(viewSelection.endLineNumber, viewSelection.endColumn, cursor.getSelection().getEndPosition());
			viewLineNumber = viewSelectionEnd.lineNumber;
			viewColumn = viewSelectionEnd.column;
		} else {
			let validatedViewPosition = cursor.getValidViewPosition();
			viewLineNumber = validatedViewPosition.lineNumber;
			viewColumn = validatedViewPosition.column;
		}

		let r = cursor.getViewPositionDown(viewLineNumber, viewColumn, cursor.getLeftoverVisibleColumns(), linesCount, true);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(inSelectionMode, r.lineNumber, r.column, r.leftoverVisibleColumns, true);
		return true;
	}

	public static translateDown(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {

		let selection = cursor.getViewSelection();

		let selectionStart = cursor.getViewPositionDown(selection.selectionStartLineNumber, selection.selectionStartColumn, cursor.getSelectionStartLeftoverVisibleColumns(), 1, false);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(false, selectionStart.lineNumber, selectionStart.column, cursor.getLeftoverVisibleColumns(), true);

		let position = cursor.getViewPositionDown(selection.positionLineNumber, selection.positionColumn, cursor.getLeftoverVisibleColumns(), 1, false);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(true, position.lineNumber, position.column, position.leftoverVisibleColumns, true);

		cursor.setSelectionStartLeftoverVisibleColumns(selectionStart.leftoverVisibleColumns);

		return true;
	}

	public static moveUp(cursor:OneCursor, inSelectionMode: boolean, isPaged: boolean, usePageSize: number, ctx: IOneCursorOperationContext): boolean {
		let linesCount = isPaged ? (usePageSize || cursor.getPageSize()) : 1;

		let viewLineNumber:number,
			viewColumn:number;

		if (cursor.hasSelection() && !inSelectionMode) {
			// If we are in selection mode, move up acts relative to the beginning of selection
			let viewSelection = cursor.getViewSelection();
			let viewSelectionStart = cursor.validateViewPosition(viewSelection.startLineNumber, viewSelection.startColumn, cursor.getSelection().getStartPosition());
			viewLineNumber = viewSelectionStart.lineNumber;
			viewColumn = viewSelectionStart.column;
		} else {
			let validatedViewPosition = cursor.getValidViewPosition();
			viewLineNumber = validatedViewPosition.lineNumber;
			viewColumn = validatedViewPosition.column;
		}

		let r = cursor.getViewPositionUp(viewLineNumber, viewColumn, cursor.getLeftoverVisibleColumns(), linesCount, true);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(inSelectionMode, r.lineNumber, r.column, r.leftoverVisibleColumns, true);

		return true;
	}

	public static translateUp(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {

		let selection = cursor.getViewSelection();

		let selectionStart = cursor.getViewPositionUp(selection.selectionStartLineNumber, selection.selectionStartColumn, cursor.getSelectionStartLeftoverVisibleColumns(), 1, false);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(false, selectionStart.lineNumber, selectionStart.column, cursor.getLeftoverVisibleColumns(), true);

		let position = cursor.getViewPositionUp(selection.positionLineNumber, selection.positionColumn, cursor.getLeftoverVisibleColumns(), 1, false);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(true, position.lineNumber, position.column, position.leftoverVisibleColumns, true);

		cursor.setSelectionStartLeftoverVisibleColumns(selectionStart.leftoverVisibleColumns);

		return true;
	}

	public static moveToBeginningOfLine(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		let viewPosition = cursor.getValidViewPosition();
		let viewLineNumber = viewPosition.lineNumber;
		let viewColumn = viewPosition.column;

		viewColumn = cursor.getColumnAtBeginningOfViewLine(viewLineNumber, viewColumn);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(inSelectionMode, viewLineNumber, viewColumn, 0, true);
		return true;
	}

	public static moveToHardBeginningOfLine(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		let viewPosition = cursor.getValidViewPosition();
		let viewLineNumber = viewPosition.lineNumber;
		let viewColumn = viewPosition.column;

		viewColumn = cursor.getViewLineMinColumn(viewLineNumber);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(inSelectionMode, viewLineNumber, viewColumn, 0, true);
		return true;
	}

	public static moveToEndOfLine(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		let validatedViewPosition = cursor.getValidViewPosition();
		let viewLineNumber = validatedViewPosition.lineNumber;
		let viewColumn = validatedViewPosition.column;

		viewColumn = cursor.getColumnAtEndOfViewLine(viewLineNumber, viewColumn);
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveViewPosition(inSelectionMode, viewLineNumber, viewColumn, 0, true);
		return true;
	}

	public static expandLineSelection(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		let viewSel = cursor.getViewSelection();

		let viewStartLineNumber = viewSel.startLineNumber;
		let viewStartColumn = viewSel.startColumn;
		let viewEndLineNumber = viewSel.endLineNumber;
		let viewEndColumn = viewSel.endColumn;

		let viewEndMaxColumn = cursor.getViewLineMaxColumn(viewEndLineNumber);
		if (viewStartColumn !== 1 || viewEndColumn !== viewEndMaxColumn) {
			viewStartColumn = 1;
			viewEndColumn = viewEndMaxColumn;
		} else {
			// Expand selection with one more line down
			let moveResult = cursor.getViewPositionDown(viewEndLineNumber, viewEndColumn, 0, 1, true);
			viewEndLineNumber = moveResult.lineNumber;
			viewEndColumn = cursor.getViewLineMaxColumn(viewEndLineNumber);
		}

		cursor.moveViewPosition(false, viewStartLineNumber, viewStartColumn, 0, true);
		cursor.moveViewPosition(true, viewEndLineNumber, viewEndColumn, 0, true);
		return true;
	}

	public static moveToBeginningOfBuffer(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveModelPosition(inSelectionMode, 1, 1, 0, true);
		return true;
	}

	public static moveToEndOfBuffer(cursor:OneCursor, inSelectionMode: boolean, ctx: IOneCursorOperationContext): boolean {
		let lastLineNumber = cursor.model.getLineCount();
		let lastColumn = cursor.model.getLineMaxColumn(lastLineNumber);

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveModelPosition(inSelectionMode, lastLineNumber, lastColumn, 0, true);
		return true;
	}

	public static selectAll(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {

		let selectEntireBuffer = true;
		let newSelectionStartLineNumber: number,
			newSelectionStartColumn: number,
			newPositionLineNumber: number,
			newPositionColumn: number;

		if (cursor.model.hasEditableRange()) {
			// Toggle between selecting editable range and selecting the entire buffer

			let editableRange = cursor.model.getEditableRange();
			let selection = cursor.getSelection();

			if (!selection.equalsRange(editableRange)) {
				// Selection is not editable range => select editable range
				selectEntireBuffer = false;
				newSelectionStartLineNumber = editableRange.startLineNumber;
				newSelectionStartColumn = editableRange.startColumn;
				newPositionLineNumber = editableRange.endLineNumber;
				newPositionColumn = editableRange.endColumn;
			}
		}

		if (selectEntireBuffer) {
			newSelectionStartLineNumber = 1;
			newSelectionStartColumn = 1;
			newPositionLineNumber = cursor.model.getLineCount();
			newPositionColumn = cursor.model.getLineMaxColumn(newPositionLineNumber);
		}

		cursor.moveModelPosition(false, newSelectionStartLineNumber, newSelectionStartColumn, 0, false);
		cursor.moveModelPosition(true, newPositionLineNumber, newPositionColumn, 0, false);

		ctx.shouldReveal = false;
		ctx.shouldRevealHorizontal = false;
		return true;
	}

	public static line(cursor:OneCursor, inSelectionMode: boolean, _position:editorCommon.IPosition, _viewPosition:editorCommon.IPosition, ctx: IOneCursorOperationContext): boolean {
		// TODO@Alex -> select in editable range

		let position = cursor.validatePosition(_position);
		let viewPosition = (
			_viewPosition ?
			cursor.validateViewPosition(_viewPosition.lineNumber, _viewPosition.column, position)
			: cursor.convertModelPositionToViewPosition(position.lineNumber, position.column)
		);

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		ctx.shouldRevealHorizontal = false;

		if (!inSelectionMode || !cursor.hasSelection()) {
			// Entering line selection for the first time

			let selectToLineNumber = position.lineNumber + 1;
			let selectToColumn = 1;
			if (selectToLineNumber > cursor.model.getLineCount()) {
				selectToLineNumber = cursor.model.getLineCount();
				selectToColumn = cursor.model.getLineMaxColumn(selectToLineNumber);
			}

			let selectionStartRange = new Range(position.lineNumber, 1, selectToLineNumber, selectToColumn);
			let r1 = cursor.convertModelPositionToViewPosition(position.lineNumber, 1);
			let r2 = cursor.convertModelPositionToViewPosition(selectToLineNumber, selectToColumn);
			cursor.setSelectionStart(selectionStartRange, new Range(r1.lineNumber, r1.column, r2.lineNumber, r2.column));
			cursor.moveModelPosition(cursor.hasSelection(), selectionStartRange.endLineNumber, selectionStartRange.endColumn, 0, false);

			return true;
		} else {
			// Continuing line selection
			let enteringLineNumber = cursor.getSelectionStart().getStartPosition().lineNumber;

			if (position.lineNumber < enteringLineNumber) {

				cursor.moveViewPosition(cursor.hasSelection(), viewPosition.lineNumber, 1, 0, false);

			} else if (position.lineNumber > enteringLineNumber) {

				let selectToViewLineNumber = viewPosition.lineNumber + 1;
				let selectToViewColumn = 1;
				if (selectToViewLineNumber > cursor.getViewLineCount()) {
					selectToViewLineNumber = cursor.getViewLineCount();
					selectToViewColumn = cursor.getViewLineMaxColumn(selectToViewLineNumber);
				}
				cursor.moveViewPosition(cursor.hasSelection(), selectToViewLineNumber, selectToViewColumn, 0, false);

			} else {

				let endPositionOfSelectionStart = cursor.getSelectionStart().getEndPosition();
				cursor.moveModelPosition(cursor.hasSelection(), endPositionOfSelectionStart.lineNumber, endPositionOfSelectionStart.column, 0, false);

			}


			return true;
		}

	}

	public static word(cursor:OneCursor, inSelectionMode: boolean, position: editorCommon.IPosition, ctx: IOneCursorOperationContext): boolean {
		// TODO@Alex -> select in editable range

		let validatedPosition = cursor.validatePosition(position);
		let prevWord = cursor.findPreviousWordOnLine(validatedPosition);
		let isInPrevWord = (prevWord && prevWord.wordType === WordType.Regular && prevWord.start < validatedPosition.column - 1 && validatedPosition.column - 1 <= prevWord.end);
		let nextWord = cursor.findNextWordOnLine(validatedPosition);
		let isInNextWord = (nextWord && nextWord.wordType === WordType.Regular && nextWord.start < validatedPosition.column - 1 && validatedPosition.column - 1 <= nextWord.end);

		let lineNumber: number;
		let column: number;
		if (!inSelectionMode || !cursor.hasSelection()) {

			let startColumn: number;
			let endColumn: number;

			if (isInPrevWord) {
				startColumn = prevWord.start + 1;
				endColumn = prevWord.end + 1;
			} else if (isInNextWord) {
				startColumn = nextWord.start + 1;
				endColumn = nextWord.end + 1;
			} else {
				if (prevWord) {
					startColumn = prevWord.end + 1;
				} else {
					startColumn = 1;
				}
				if (nextWord) {
					endColumn = nextWord.start + 1;
				} else {
					endColumn = cursor.model.getLineMaxColumn(validatedPosition.lineNumber);
				}
			}

			let selectionStartRange = new Range(validatedPosition.lineNumber, startColumn, validatedPosition.lineNumber, endColumn);
			let r1 = cursor.convertModelPositionToViewPosition(validatedPosition.lineNumber, startColumn);
			let r2 = cursor.convertModelPositionToViewPosition(validatedPosition.lineNumber, endColumn);
			cursor.setSelectionStart(selectionStartRange, new Range(r1.lineNumber, r1.column, r2.lineNumber, r2.column));
			lineNumber = selectionStartRange.endLineNumber;
			column = selectionStartRange.endColumn;
		} else {

			let startColumn: number;
			let endColumn: number;

			if (isInPrevWord) {
				startColumn = prevWord.start + 1;
				endColumn = prevWord.end + 1;
			} else if (isInNextWord) {
				startColumn = nextWord.start + 1;
				endColumn = nextWord.end + 1;
			} else {
				startColumn = validatedPosition.column;
				endColumn = validatedPosition.column;
			}

			lineNumber = validatedPosition.lineNumber;
			if (validatedPosition.isBeforeOrEqual(cursor.getSelectionStart().getStartPosition())) {
				column = startColumn;
				let possiblePosition = new Position(lineNumber, column);
				if (cursor.getSelectionStart().containsPosition(possiblePosition)) {
					column = cursor.getSelectionStart().endColumn;
				}
			} else {
				column = endColumn;
				let possiblePosition = new Position(lineNumber, column);
				if (cursor.getSelectionStart().containsPosition(possiblePosition)) {
					column = cursor.getSelectionStart().startColumn;
				}
			}
		}

		ctx.cursorPositionChangeReason = editorCommon.CursorChangeReason.Explicit;
		cursor.moveModelPosition(cursor.hasSelection(), lineNumber, column, 0, false);
		return true;
	}

	public static cancelSelection(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.hasSelection()) {
			return false;
		}

		cursor.collapseSelection();
		return true;
	}

	// -------------------- STOP handlers that simply change cursor state



	// -------------------- START type interceptors & co.

	private static _typeInterceptorEnter(cursor:OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (ch !== '\n') {
			return false;
		}

		return this._enter(cursor, false, ctx);
	}

	public static lineInsertBefore(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		let lineNumber = cursor.getPosition().lineNumber;

		if (lineNumber === 1) {
			ctx.executeCommand = new ReplaceCommandWithoutChangingPosition(new Range(1,1,1,1), '\n');
			return true;
		}

		lineNumber--;
		let column = cursor.model.getLineMaxColumn(lineNumber);

		return this._enter(cursor, false, ctx, new Position(lineNumber, column), new Range(lineNumber, column, lineNumber, column));
	}

	public static lineInsertAfter(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		let position = cursor.getPosition();
		let column = cursor.model.getLineMaxColumn(position.lineNumber);
		return this._enter(cursor, false, ctx, new Position(position.lineNumber, column), new Range(position.lineNumber, column, position.lineNumber, column));
	}

	public static lineBreakInsert(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		return this._enter(cursor, true, ctx);
	}

	private static _enter(cursor:OneCursor, keepPosition: boolean, ctx: IOneCursorOperationContext, position?: Position, range?: Range): boolean {
		if (typeof position === 'undefined') {
			position = cursor.getPosition();
		}
		if (typeof range === 'undefined') {
			range = cursor.getSelection();
		}
		ctx.shouldPushStackElementBefore = true;

		let r = LanguageConfigurationRegistry.getEnterActionAtPosition(cursor.model, position.lineNumber, position.column);
		let enterAction = r.enterAction;
		let indentation = r.indentation;

		ctx.isAutoWhitespaceCommand = true;
		if (enterAction.indentAction === IndentAction.None) {
			// Nothing special
			this.actualType(cursor, '\n' + cursor.model.normalizeIndentation(indentation + enterAction.appendText), keepPosition, ctx, range);

		} else if (enterAction.indentAction === IndentAction.Indent) {
			// Indent once
			this.actualType(cursor, '\n' + cursor.model.normalizeIndentation(indentation + enterAction.appendText), keepPosition, ctx, range);

		} else if (enterAction.indentAction === IndentAction.IndentOutdent) {
			// Ultra special
			let normalIndent = cursor.model.normalizeIndentation(indentation);
			let increasedIndent = cursor.model.normalizeIndentation(indentation + enterAction.appendText);

			let typeText = '\n' + increasedIndent + '\n' + normalIndent;

			if (keepPosition) {
				ctx.executeCommand = new ReplaceCommandWithoutChangingPosition(range, typeText);
			} else {
				ctx.executeCommand = new ReplaceCommandWithOffsetCursorState(range, typeText, -1, increasedIndent.length - normalIndent.length);
			}
		} else if (enterAction.indentAction === IndentAction.Outdent) {
			let desiredIndentCount = ShiftCommand.unshiftIndentCount(indentation, indentation.length + 1, cursor.model.getOptions().tabSize);
			let actualIndentation = '';
			for (let i = 0; i < desiredIndentCount; i++) {
				actualIndentation += '\t';
			}
			this.actualType(cursor, '\n' + cursor.model.normalizeIndentation(actualIndentation + enterAction.appendText), keepPosition, ctx, range);
		}

		return true;
	}

	private static _typeInterceptorAutoClosingCloseChar(cursor:OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.configuration.editor.autoClosingBrackets) {
			return false;
		}

		let selection = cursor.getSelection();

		if (!selection.isEmpty() || !cursor.modeConfiguration.autoClosingPairsClose.hasOwnProperty(ch)) {
			return false;
		}

		let position = cursor.getPosition();

		let lineText = cursor.model.getLineContent(position.lineNumber);
		let beforeCharacter = lineText[position.column - 1];

		if (beforeCharacter !== ch) {
			return false;
		}

		let typeSelection = new Range(position.lineNumber, position.column, position.lineNumber, position.column + 1);
		ctx.executeCommand = new ReplaceCommand(typeSelection, ch);
		return true;
	}

	private static _typeInterceptorAutoClosingOpenChar(cursor:OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.configuration.editor.autoClosingBrackets) {
			return false;
		}

		let selection = cursor.getSelection();

		if (!selection.isEmpty() || !cursor.modeConfiguration.autoClosingPairsOpen.hasOwnProperty(ch)) {
			return false;
		}

		let characterPairSupport = LanguageConfigurationRegistry.getCharacterPairSupport(cursor.model.getMode().getId());

		if(!characterPairSupport) {
			return false;
		}

		let position = cursor.getPosition();
		let lineText = cursor.model.getLineContent(position.lineNumber);
		let beforeCharacter = lineText[position.column - 1];

		// Only consider auto closing the pair if a space follows or if another autoclosed pair follows
		if (beforeCharacter) {
			let isBeforeCloseBrace = false;
			for (let closeBrace in cursor.modeConfiguration.autoClosingPairsClose) {
				if (beforeCharacter === closeBrace) {
					isBeforeCloseBrace = true;
					break;
				}
			}
			if ( !isBeforeCloseBrace && !/\s/.test(beforeCharacter)) {
				return false;
			}
		}

		let lineContext = cursor.model.getLineContext(position.lineNumber);

		let shouldAutoClosePair = false;
		try {
			shouldAutoClosePair = characterPairSupport.shouldAutoClosePair(ch, lineContext, position.column - 1);
		} catch(e) {
			onUnexpectedError(e);
		}

		if (!shouldAutoClosePair) {
			return false;
		}

		ctx.shouldPushStackElementBefore = true;
		let closeCharacter = cursor.modeConfiguration.autoClosingPairsOpen[ch];
		ctx.executeCommand = new ReplaceCommandWithOffsetCursorState(selection, ch + closeCharacter, 0, -closeCharacter.length);
		return true;
	}

	private static _typeInterceptorSurroundSelection(cursor:OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.configuration.editor.autoClosingBrackets) {
			return false;
		}

		let selection = cursor.getSelection();

		if (selection.isEmpty() || !cursor.modeConfiguration.surroundingPairs.hasOwnProperty(ch)) {
			return false;
		}

		let selectionContainsOnlyWhitespace = true,
			lineNumber:number,
			startIndex:number,
			endIndex:number,
			charIndex:number,
			charCode:number,
			lineText:string,
			_tab = '\t'.charCodeAt(0),
			_space = ' '.charCodeAt(0);

		for (lineNumber = selection.startLineNumber; lineNumber <= selection.endLineNumber; lineNumber++) {
			lineText = cursor.model.getLineContent(lineNumber);
			startIndex = (lineNumber === selection.startLineNumber ? selection.startColumn - 1 : 0);
			endIndex = (lineNumber === selection.endLineNumber ? selection.endColumn - 1 : lineText.length);
			for (charIndex = startIndex; charIndex < endIndex; charIndex++) {
				charCode = lineText.charCodeAt(charIndex);
				if (charCode !== _tab && charCode !== _space) {
					selectionContainsOnlyWhitespace = false;

					// Break outer loop
					lineNumber = selection.endLineNumber + 1;

					// Break inner loop
					charIndex = endIndex;
				}
			}
		}

		if (selectionContainsOnlyWhitespace) {
			return false;
		}

		let closeCharacter = cursor.modeConfiguration.surroundingPairs[ch];

		ctx.shouldPushStackElementBefore = true;
		ctx.shouldPushStackElementAfter = true;
		ctx.executeCommand = new SurroundSelectionCommand(selection, ch, closeCharacter);
		return true;
	}

	private static _typeInterceptorElectricChar(cursor:OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {
		if (!cursor.modeConfiguration.electricChars.hasOwnProperty(ch)) {
			return false;
		}

		ctx.postOperationRunnable = (postOperationCtx: IOneCursorOperationContext) => this._typeInterceptorElectricCharRunnable(cursor, postOperationCtx);

		return this.actualType(cursor, ch, false, ctx);
	}

	private static _typeInterceptorElectricCharRunnable(cursor:OneCursor, ctx: IOneCursorOperationContext): void {

		let position = cursor.getPosition();
		let lineText = cursor.model.getLineContent(position.lineNumber);
		let lineContext = cursor.model.getLineContext(position.lineNumber);

		let electricAction:IElectricAction;
		let electricCharSupport = LanguageConfigurationRegistry.getElectricCharacterSupport(cursor.model.getMode().getId());
		if (electricCharSupport) {
			try {
				electricAction = electricCharSupport.onElectricCharacter(lineContext, position.column - 2);
			} catch(e) {
				onUnexpectedError(e);
			}
		}

		if (electricAction) {
			let matchOpenBracket = electricAction.matchOpenBracket;
			let appendText = electricAction.appendText;
			if (matchOpenBracket) {
				let match = cursor.model.findMatchingBracketUp(matchOpenBracket, {
					lineNumber: position.lineNumber,
					column: position.column - matchOpenBracket.length
				});
				if (match) {
					let matchLineNumber = match.startLineNumber;
					let matchLine = cursor.model.getLineContent(matchLineNumber);
					let matchLineIndentation = strings.getLeadingWhitespace(matchLine);
					let newIndentation = cursor.model.normalizeIndentation(matchLineIndentation);

					let lineFirstNonBlankColumn = cursor.model.getLineFirstNonWhitespaceColumn(position.lineNumber) || position.column;
					let oldIndentation = lineText.substring(0, lineFirstNonBlankColumn - 1);

					if (oldIndentation !== newIndentation) {
						let prefix = lineText.substring(lineFirstNonBlankColumn - 1, position.column - 1);
						let typeText = newIndentation + prefix;

						let typeSelection = new Range(position.lineNumber, 1, position.lineNumber, position.column);
						ctx.shouldPushStackElementAfter = true;
						ctx.executeCommand = new ReplaceCommand(typeSelection, typeText);
					}
				}
			} else if (appendText) {
				let columnDeltaOffset = -appendText.length;
				if (electricAction.advanceCount) {
					columnDeltaOffset += electricAction.advanceCount;
				}
				ctx.shouldPushStackElementAfter = true;
				ctx.executeCommand = new ReplaceCommandWithOffsetCursorState(cursor.getSelection(), appendText, 0, columnDeltaOffset);
			}
		}
	}

	public static actualType(cursor:OneCursor, text: string, keepPosition: boolean, ctx: IOneCursorOperationContext, range?: Range): boolean {
		if (typeof range === 'undefined') {
			range = cursor.getSelection();
		}
		if (keepPosition) {
			ctx.executeCommand = new ReplaceCommandWithoutChangingPosition(range, text);
		} else {
			ctx.executeCommand = new ReplaceCommand(range, text);
		}
		return true;
	}

	public static type(cursor:OneCursor, ch: string, ctx: IOneCursorOperationContext): boolean {

		if (this._typeInterceptorEnter(cursor, ch, ctx)) {
			return true;
		}

		if (this._typeInterceptorAutoClosingCloseChar(cursor, ch, ctx)) {
			return true;
		}

		if (this._typeInterceptorAutoClosingOpenChar(cursor, ch, ctx)) {
			return true;
		}

		if (this._typeInterceptorSurroundSelection(cursor, ch, ctx)) {
			return true;
		}

		if (this._typeInterceptorElectricChar(cursor, ch, ctx)) {
			return true;
		}

		return this.actualType(cursor, ch, false, ctx);
	}

	public static replacePreviousChar(cursor:OneCursor, txt: string, replaceCharCnt:number, ctx: IOneCursorOperationContext): boolean {
		let pos = cursor.getPosition();
		let range: Range;
		let startColumn = Math.max(1, pos.column - replaceCharCnt);
		range = new Range(pos.lineNumber, startColumn, pos.lineNumber, pos.column);
		ctx.executeCommand = new ReplaceCommand(range, txt);
		return true;
	}

	private static _goodIndentForLine(cursor:OneCursor, lineNumber:number): string {
		let lastLineNumber = lineNumber - 1;

		for (lastLineNumber = lineNumber - 1; lastLineNumber >= 1; lastLineNumber--) {
			let lineText = cursor.model.getLineContent(lastLineNumber);
			let nonWhitespaceIdx = strings.lastNonWhitespaceIndex(lineText);
			if (nonWhitespaceIdx >= 0) {
				break;
			}
		}

		if (lastLineNumber < 1) {
			// No previous line with content found
			return '\t';
		}

		let r = LanguageConfigurationRegistry.getEnterActionAtPosition(cursor.model, lastLineNumber, cursor.model.getLineMaxColumn(lastLineNumber));

		let indentation: string;
		if (r.enterAction.indentAction === IndentAction.Outdent) {
			let modelOpts = cursor.model.getOptions();
			let desiredIndentCount = ShiftCommand.unshiftIndentCount(r.indentation, r.indentation.length, modelOpts.tabSize);
			indentation = '';
			for (let i = 0; i < desiredIndentCount; i++) {
				indentation += '\t';
			}
			indentation = cursor.model.normalizeIndentation(indentation);
		} else {
			indentation = r.indentation;
		}

		let result = indentation + r.enterAction.appendText;
		if (result.length === 0) {
			// good position is at column 1, but we gotta do something...
			return '\t';
		}
		return result;
	}

	public static tab(cursor:OneCursor, ctx: IOneCursorOperationContext): boolean {
		let selection = cursor.getSelection();

		if (selection.isEmpty()) {

			ctx.isAutoWhitespaceCommand = true;


			let lineText = cursor.model.getLineContent(selection.startLineNumber);
>>>>>>> origin/alex/cursorHardHome

		} else if (position.lineNumber > enteringLineNumber) {

			const lineCount = context.viewModel.getLineCount();

			let selectToViewLineNumber = viewPosition.lineNumber + 1;
			let selectToViewColumn = 1;
			if (selectToViewLineNumber > lineCount) {
				selectToViewLineNumber = lineCount;
				selectToViewColumn = context.viewModel.getLineMaxColumn(selectToViewLineNumber);
			}

			return this._fromViewCursorState(context, cursor, cursor.viewState.move(
				cursor.modelState.hasSelection(), selectToViewLineNumber, selectToViewColumn, 0
			));

		} else {

			const endPositionOfSelectionStart = cursor.modelState.selectionStart.getEndPosition();
			return this._fromModelCursorState(context, cursor, cursor.modelState.move(
				cursor.modelState.hasSelection(), endPositionOfSelectionStart.lineNumber, endPositionOfSelectionStart.column, 0
			));

		}
	}

	public static word(context: CursorContext, cursor: OneCursor, inSelectionMode: boolean, _position: editorCommon.IPosition): CursorState {
		const position = context.validateModelPosition(_position);
		return this._fromModelCursorState(context, cursor, WordOperations.word(context.config, context.model, cursor.modelState, inSelectionMode, position));
	}

	public static cancelSelection(context: CursorContext, cursor: OneCursor): CursorState {
		if (!cursor.modelState.hasSelection()) {
			return new CursorState(cursor.modelState, cursor.viewState);
		}

		const lineNumber = cursor.viewState.position.lineNumber;
		const column = cursor.viewState.position.column;

		return this._fromViewCursorState(context, cursor, new SingleCursorState(
			new Range(lineNumber, column, lineNumber, column), 0,
			new Position(lineNumber, column), 0
		));
	}

	// -------------------- STOP handlers that simply change cursor state
}
