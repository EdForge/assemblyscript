import * as ts from "byots";
import * as Long from "long";
import * as assert from "assert";
import { Profiler } from "./profiler";

import {
  formatDiagnostics,
  formatDiagnosticsWithColorAndContext,
  createDiagnosticForNode,
  printDiagnostic
} from "./diagnostics";

import {
  WasmModule,
  WasmSignature,
  WasmExpression,
  WasmTypeKind,
  WasmType,
  WasmFunctionFlags,
  WasmFunction,
  WasmVariable,
  WasmConstant
} from "./wasm";

const byteType      = new WasmType(WasmTypeKind.byte   , 1);
const sbyteType     = new WasmType(WasmTypeKind.sbyte  , 1);
const shortType     = new WasmType(WasmTypeKind.short  , 2);
const ushortType    = new WasmType(WasmTypeKind.ushort , 2);
const intType       = new WasmType(WasmTypeKind.int    , 4);
const uintType      = new WasmType(WasmTypeKind.uint   , 4);
const longType      = new WasmType(WasmTypeKind.long   , 8);
const ulongType     = new WasmType(WasmTypeKind.ulong  , 8);
const boolType      = new WasmType(WasmTypeKind.bool   , 4);
const floatType     = new WasmType(WasmTypeKind.float  , 4);
const doubleType    = new WasmType(WasmTypeKind.double , 8);
const voidType      = new WasmType(WasmTypeKind.void   , 0);
const uintptrType32 = new WasmType(WasmTypeKind.uintptr, 4);
const uintptrType64 = new WasmType(WasmTypeKind.uintptr, 8);

function isExport(node: ts.Node): boolean {
  return (node.modifierFlagsCache & ts.ModifierFlags.Export) !== 0;
}

function isImport(node: ts.Node): boolean {
  if (node.modifiers) // TODO: isn't there a flag for that?
    for (let modifier of node.modifiers)
      if (modifier.kind === ts.SyntaxKind.DeclareKeyword)
        return true;
  return false;
}

export class Compiler {
  program: ts.Program;
  checker: ts.TypeChecker;
  diagnostics: ts.DiagnosticCollection;
  uintptrType: WasmType;
  module: WasmModule;
  signatures: { [key: string]: WasmSignature } = {};
  constants: { [key: string]: WasmConstant } = {};
  profiler = new Profiler();
  currentLocals: { [key: string]: WasmVariable };

  static compile(filename: string): WasmModule {
    let program = ts.createProgram([ __dirname + "/../types/assembly.d.ts", filename ], {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.None,
      noLib: true,
      experimentalDecorators: true,
      types: []
    });

    let compiler = new Compiler(program);

    // bail out if there were 'pre emit' errors
    for (let diagnostic of ts.getPreEmitDiagnostics(compiler.program)) {
      printDiagnostic(diagnostic);
      if (diagnostic.category === ts.DiagnosticCategory.Error)
        return null;
    }

    compiler.profiler.start("initialize");
    compiler.initialize();
    process.stderr.write("initialization took " + compiler.profiler.end("initialize").toFixed(3) + " ms\n");

    // bail out if there were initialization errors
    let diagnostics = compiler.diagnostics.getDiagnostics();
    for (let diagnostic of diagnostics) {
      if (diagnostic.category === ts.DiagnosticCategory.Error)
        return null;
    }

    compiler.profiler.start("compile");
    compiler.compile();
    process.stderr.write("compilation took " + compiler.profiler.end("compile").toFixed(3) + " ms\n");

    // bail out if there were compilation errors
    diagnostics = compiler.diagnostics.getDiagnostics();
    for (let diagnostic of diagnostics) {
      if (diagnostic.category === ts.DiagnosticCategory.Error)
        return null;
    }

    return compiler.module;
  }

  constructor(program: ts.Program, uintptrSize = 4) {
    if (uintptrSize !== 4 && uintptrSize !== 8)
      throw Error("unsupported uintptrSize");

    this.program = program;
    this.checker = program.getDiagnosticsProducingTypeChecker();
    this.diagnostics = ts.createDiagnosticCollection();
    this.module = new WasmModule();
    this.uintptrType = uintptrSize === 4 ? uintptrType32 : uintptrType64;
  }

  info(node: ts.Node, message: string, arg1?: string): void {
    const diagnostic = createDiagnosticForNode(node, ts.DiagnosticCategory.Message, message, arg1);
    this.diagnostics.add(diagnostic);
    printDiagnostic(diagnostic);
  }

  warn(node: ts.Node, message: string, arg1?: string): void {
    const diagnostic = createDiagnosticForNode(node, ts.DiagnosticCategory.Warning, message, arg1);
    this.diagnostics.add(diagnostic);
    printDiagnostic(diagnostic);
  }

  error(node: ts.Node, message: string, arg1?: string): void {
    const diagnostic = createDiagnosticForNode(node, ts.DiagnosticCategory.Error, message, arg1);
    this.diagnostics.add(diagnostic);
    printDiagnostic(diagnostic);
  }

  initialize(): void {
    const compiler = this;

    this.module.setMemory(256, 0, "memory", []); // "unexpected true: memory max >= initial" (but the result is correct: growable)

    // TODO: it seem that binaryen.js doesn't support importing memory yet

    for (let file of this.program.getSourceFiles()) {
      if (file.isDeclarationFile) continue;
      ts.forEachChild(file, visit);
    }

    function visit(node: ts.Node) {
      switch (node.kind) {
        case ts.SyntaxKind.VariableStatement:
          compiler.initializeVariable(<ts.VariableStatement>node);
          break;
        case ts.SyntaxKind.FunctionDeclaration:
          compiler.initializeFunction(<ts.FunctionDeclaration>node);
          break;
        case ts.SyntaxKind.ClassDeclaration:
          compiler.initializeClass(<ts.ClassDeclaration>node);
          break;
        case ts.SyntaxKind.EnumDeclaration:
          compiler.initializeEnum(<ts.EnumDeclaration>node);
          break;
        case ts.SyntaxKind.EndOfFileToken:
          break;
        default:
          throw Error("unsupported top-level node: " + ts.SyntaxKind[node.kind]);
      }
    }
  }

  initializeVariable(node: ts.VariableStatement): void {
    // TODO: it seems that binaryen.js does not support globals, yet
  }

  private _initializeFunction(node: ts.FunctionDeclaration | ts.MethodDeclaration, parent?: ts.ClassDeclaration, isInstance: boolean = false): void {
    const name = node.symbol.name;

    if (node.typeParameters && node.typeParameters.length !== 0)
      this.error(node.typeParameters[0], "Type parameters are not supported yet");

    var parameters: WasmType[] = [];
    var signatureIdentifiers: string[] = [];
    var signatureTypes: number[] = [];

    if (parent && isInstance) {
      const thisType = this.uintptrType; // TODO: underlyingType
      parameters.push(thisType);
      signatureIdentifiers.push(thisType.toSignatureIdentifier(this.uintptrType));
      signatureTypes.push(thisType.toBinaryenType(this.uintptrType));
    }

    node.parameters.forEach(parameter => {
      const name = parameter.symbol.name;
      const type = this.resolveType(parameter.type);
      parameters.push(type);
      signatureIdentifiers.push(type.toSignatureIdentifier(this.uintptrType));
      signatureTypes.push(type.toBinaryenType(this.uintptrType));
    });

    const returnType = this.resolveType(node.type, true);
    signatureIdentifiers.push(returnType.toSignatureIdentifier(this.uintptrType));

    const signatureKey = signatureIdentifiers.join("");
    let signature = this.signatures[signatureKey];
    if (!signature)
      signature = this.signatures[signatureKey] = this.module.addFunctionType(signatureKey, returnType.toBinaryenType(this.uintptrType), signatureTypes);
    let flags = 0;

    if (isExport(node))
      flags |= WasmFunctionFlags.export;

    if (isImport(node))
      flags |= WasmFunctionFlags.import;

    (<any>node).wasmFunction = {
      name: parent ? parent.symbol.name + "$" + name : name,
      parameters: parameters,
      returnType: returnType,
      flags: flags,
      signature: signature
    };
  }

  initializeFunction(node: ts.FunctionDeclaration): void {
    this._initializeFunction(node);
  }

  initializeClass(node: ts.ClassDeclaration): void {
    const compiler = this;
    const clazz = node;
    const name = node.symbol.name;

    ts.forEachChild(node, visit);

    function visit(node: ts.Node): void {
      switch (node.kind) {

        case ts.SyntaxKind.Identifier:
          break;

        case ts.SyntaxKind.MethodDeclaration:
          if (isExport(node))
            compiler.error(node, "Class methods cannot be exports");
          if (isImport(node))
            compiler.error(node, "Class methods cannot be imports");
          compiler._initializeFunction(<ts.MethodDeclaration>node, clazz, (node.modifierFlagsCache & ts.ModifierFlags.Static) === 0);
          break;

        default:
          compiler.error(node, "Unsupported class member", ts.SyntaxKind[node.kind]);

      }
    }
  }

  initializeEnum(node: ts.EnumDeclaration): void {
    const compiler = this;
    const name = node.symbol.name;

    ts.forEachChild(node, visit);

    function visit(node: ts.Node): void {
      switch (node.kind) {

        case ts.SyntaxKind.Identifier:
          break;

        case ts.SyntaxKind.EnumMember:
        {
          var member = <ts.EnumMember>node;
          compiler.constants[name + "$" + member.symbol.name] = {
            type: intType,
            value: compiler.checker.getConstantValue(member)
          };
          break;
        }

        default:
          compiler.error(node, "Unsupported enum member", ts.SyntaxKind[node.kind]);

      }
    }
  }

  compile(): void {
    const compiler = this;

    this.module.autoDrop();

    for (let file of this.program.getSourceFiles()) {
      if (file.isDeclarationFile) continue;
      ts.forEachChild(file, visit);
    }

    function visit(node: ts.Node) {
      switch (node.kind) {

        case ts.SyntaxKind.VariableStatement:
          compiler.compileVariable(<ts.VariableStatement>node);
          break;

        case ts.SyntaxKind.FunctionDeclaration:
          compiler.compileFunction(<ts.FunctionDeclaration>node);
          break;

        case ts.SyntaxKind.ClassDeclaration:
          compiler.compileClass(<ts.ClassDeclaration>node);
          break;

        // default:
        // already reported by initialize

      }
    }
  }

  compileVariable(node: ts.VariableStatement): void {
    // TODO
  }

  private _compileFunction(node: ts.FunctionDeclaration | ts.MethodDeclaration) {
    const wasmFunction: WasmFunction = (<any>node).wasmFunction;
    const compiler = this;
    const body = [];
    const locals: { [key: string]: WasmVariable } = {};

    const op = this.module;

    node.parameters.forEach((parameter, i) => {
      locals[parameter.symbol.name] = {
        index: i,
        type: wasmFunction.parameters[i]
      }
    });

    this.currentLocals = locals;

    ts.forEachChild(node.body, visit);

    function visit(node: ts.Node) {
      switch (node.kind) {

        case ts.SyntaxKind.ReturnStatement:
        {
          const stmt = <ts.ReturnStatement>node;
          if (wasmFunction.returnType === voidType) {
            if (stmt.getChildCount() > 1) // return keyword
              compiler.error(stmt, "A function without a return type cannot return a value", wasmFunction.name);
            body.push(op.return());
          } else {
            if (stmt.getChildCount() < 2) // return keyword + expression
              compiler.error(stmt, "A function with a return type must return a value", wasmFunction.name);
            const expr = <ts.Expression>stmt.getChildAt(1);
            body.push(
              op.return(
                compiler.convertValue(
                  expr,
                  compiler.compileExpression(expr, wasmFunction.returnType),
                  (<any>expr).wasmType,
                  wasmFunction.returnType,
                  false
                )
              )
            );
          }
          break;
        }

        default:
          compiler.error(node, "Unsupported function body node", ts.SyntaxKind[node.kind]);
      }
    }

    if (body.length == 0)
      body.push(this.module.return());

    return this.module.addFunction(wasmFunction.name, wasmFunction.signature, [], body);
  }

  compileFunction(node: ts.FunctionDeclaration): void {
    const wasmFunction: WasmFunction = (<any>node).wasmFunction;
    const name = node.symbol.name;

    if ((wasmFunction.flags & WasmFunctionFlags.import) != 0) {
      let moduleName: string;
      let baseName: string;
      var idx = name.indexOf("$");
      if (idx > 0) {
        moduleName = name.substring(0, idx);
        baseName = name.substring(idx + 1);
      } else {
        moduleName = "env";
        baseName = name;
      }
      this.module.addImport(name, moduleName, baseName, wasmFunction.signature);
      return;
    }

    const func = this._compileFunction(node);

    if ((node.modifierFlagsCache & ts.ModifierFlags.Export) != 0)
      this.module.addExport(name, name);

    if (name === "start")
      this.module.setStart(func);
  }

  compileClass(node: ts.ClassDeclaration): void {
    const compiler = this;
    const clazz = node;
    const name = node.symbol.name;

    ts.forEachChild(node, visit);

    function visit(node: ts.Node) {
      switch (node.kind) {

        case ts.SyntaxKind.MethodDeclaration:
          compiler._compileFunction(<ts.MethodDeclaration>node);
          break;

        // default:
        // already reported by initialize
      }
    }
  }

  compileExpression(node: ts.Expression, contextualType: WasmType): WasmExpression {
    const op = this.module;

    // remember to always set 'wasmType' on 'node' here

    switch (node.kind) {

      case ts.SyntaxKind.ParenthesizedExpression:
      {
        const expr = (<ts.ParenthesizedExpression>node).expression;
        const compiled = this.compileExpression(expr, contextualType);
        (<any>node).wasmType = (<any>expr).wasmType;
        return compiled;
      }

      case ts.SyntaxKind.AsExpression:
      {
        const expr = <ts.AsExpression>node;
        const asType = this.resolveType(expr.type);
        (<any>node).wasmType = asType;
        return this.convertValue(node, this.compileExpression(expr.expression, contextualType), (<any>expr.expression).wasmType, asType, true);
      }

      case ts.SyntaxKind.BinaryExpression:
      {
        const expr = <ts.BinaryExpression>node;
        let left = this.compileExpression(expr.left, contextualType);
        let right = this.compileExpression(expr.right, contextualType);
        let leftType: WasmType = (<any>expr.left).wasmType;
        let rightType: WasmType = (<any>expr.right).wasmType;
        let resultType: WasmType;

        if (leftType.isFloat) {
          if (rightType.isFloat)
            resultType = leftType.size > rightType.size ? leftType : rightType;
          else
            resultType = leftType;
        } else if (rightType.isFloat) {
          resultType = rightType;
        } else {
          resultType = leftType.size > rightType.size ? leftType : rightType;
        }

        // compile again with contextual result type so that literals are properly coerced
        if (leftType !== resultType)
          left = this.convertValue(expr.left, this.compileExpression(expr.left, resultType), leftType, resultType, false);
        if (rightType !== resultType)
          right = this.convertValue(expr.right, this.compileExpression(expr.right, resultType), rightType, resultType, false);

        if (resultType === floatType) {

          (<any>expr).wasmType = floatType;

          switch (expr.operatorToken.kind) {

            case ts.SyntaxKind.PlusToken:
              return op.f32.add(left, right);

            case ts.SyntaxKind.MinusToken:
              return op.f32.sub(left, right);

            case ts.SyntaxKind.AsteriskToken:
              return op.f32.mul(left, right);

            case ts.SyntaxKind.SlashToken:
              return op.f32.div(left, right);

          }

        } else if (resultType === doubleType) {

          (<any>expr).wasmType = doubleType;

          switch (expr.operatorToken.kind) {

            case ts.SyntaxKind.PlusToken:
              return op.f64.add(left, right);

            case ts.SyntaxKind.MinusToken:
              return op.f64.sub(left, right);

            case ts.SyntaxKind.AsteriskToken:
              return op.f64.mul(left, right);

            case ts.SyntaxKind.SlashToken:
              return op.f64.div(left, right);

          }

        } else if (resultType.isLong) {

          (<any>expr).wasmType = longType;

          switch (expr.operatorToken.kind) {

            case ts.SyntaxKind.PlusToken:
              return op.i64.add(left, right);

            case ts.SyntaxKind.MinusToken:
              return op.i64.sub(left, right);

            case ts.SyntaxKind.AsteriskToken:
              return op.i64.mul(left, right);

            case ts.SyntaxKind.SlashToken:
              if (resultType.isSigned)
                return op.i64.div_s(left, right);
              else
                return op.i64.div_u(left, right);

            case ts.SyntaxKind.PercentToken:
              if (resultType.isSigned)
                return op.i64.rem_s(left, right);
              else
                return op.i64.rem_u(left, right);

            case ts.SyntaxKind.AmpersandToken:
              return op.i64.and(left, right);

            case ts.SyntaxKind.BarToken:
              return op.i64.or(left, right);

            case ts.SyntaxKind.CaretToken:
              return op.i64.xor(left, right);

            case ts.SyntaxKind.LessThanLessThanToken:
              return op.i64.shl(left, right);

            case ts.SyntaxKind.GreaterThanGreaterThanToken:
              if (resultType.isSigned)
                return op.i64.shr_s(left, right);
              else
                return op.i64.shr_u(left, right);

          }

        } else { // some i32 type

          (<any>expr).wasmType = intType;

          switch (expr.operatorToken.kind) {

            case ts.SyntaxKind.PlusToken:
              return op.i32.add(left, right);

            case ts.SyntaxKind.MinusToken:
              return op.i32.sub(left, right);

            case ts.SyntaxKind.AsteriskToken:
              return op.i32.mul(left, right);

            case ts.SyntaxKind.SlashToken:
              if (resultType.isSigned)
                return op.i32.div_s(left, right);
              else
                return op.i32.div_u(left, right);

            case ts.SyntaxKind.PercentToken:
              if (resultType.isSigned)
                return op.i32.rem_s(left, right);
              else
                return op.i32.rem_u(left, right);

            case ts.SyntaxKind.AmpersandToken:
              return op.i32.and(left, right);

            case ts.SyntaxKind.BarToken:
              return op.i32.or(left, right);

            case ts.SyntaxKind.CaretToken:
              return op.i32.xor(left, right);

            case ts.SyntaxKind.LessThanLessThanToken:
              return op.i32.shl(left, right);

            case ts.SyntaxKind.GreaterThanGreaterThanToken:
              if (resultType.isSigned)
                return op.i32.shr_s(left, right);
              else
                return op.i32.shr_u(left, right);

          }
        }

        this.error(expr.operatorToken, "Unsupported operator token", ts.SyntaxKind[expr.operatorToken.kind]);
      }

      case ts.SyntaxKind.FirstLiteralToken:
      {
        let text = (<ts.LiteralExpression>node).text;
        let radix: number;

        if (/^[1-9][0-9]*$/.test(text)) {
          radix = 10;
        } else if (/^0[xX][0-9A-Fa-f]+$/.test(text)) {
          radix = 16;
          text = text.substring(2);
        } else if (/^(?![eE])[0-9]*(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?$/.test(text)) {
          if (!contextualType.isFloat) { // explicit float in non-float context must be converted
            (<any>node).wasmType = doubleType;
            return op.f64.const(parseFloat(text));
          }
        } else {
          this.error(node, "Unsupported literal", text);
          text = "0";
          radix = 10;
        }

        (<any>node).wasmType = contextualType;

        let long: Long;
        switch (contextualType) {

          case floatType:
            return op.f32.const(parseFloat(text));

          case doubleType:
            return op.f64.const(parseFloat(text));

          case byteType:
          case sbyteType:
          case shortType:
          case ushortType:
          case intType:
          case uintType:
          case uintptrType32:
            return op.i32.const(parseInt(text, radix) & ((contextualType.size << 8) - 1));

          case longType:
          case ulongType:
          case uintptrType64:
            long = Long.fromString(text, contextualType === ulongType, radix);
            return op.i64.const(long.low, long.high);

          case boolType:
            return op.i32.const(parseInt(text, radix) !== 0 ? 1 : 0);
        }
      }

      case ts.SyntaxKind.Identifier:
      {
        const ident = <ts.Identifier>node;
        const local = this.currentLocals[ident.text];

        if (local == null) {
          this.error(node, "Undefined local variable", ident.text);
          return op.unreachable();
        }

        (<any>node).wasmType = local.type;

        return op.getLocal(local.index, local.type.toBinaryenType(this.uintptrType));
      }

      case ts.SyntaxKind.PropertyAccessExpression:
      {
        const expr = <ts.PropertyAccessExpression>node;

        if (expr.expression.kind === ts.SyntaxKind.Identifier) {
          const name = (<ts.Identifier>expr.expression).text;

          if (expr.name.kind === ts.SyntaxKind.Identifier) {
            const prop = (<ts.Identifier>expr.name).text;
            const constant = this.constants[name + "$" + prop];
            let long: Long;
            if (constant) {
              switch (constant.type) {

                case byteType:
                case sbyteType:
                case shortType:
                case ushortType:
                case intType:
                case uintType:
                case uintptrType32:
                  (<any>node).wasmType = intType;
                  return op.i32.const(constant.value);

                case longType:
                case ulongType:
                case uintptrType64:
                  long = Long.fromValue(constant.value);
                  (<any>node).wasmType = longType;
                  return op.i64.const(long.low, long.high);

                case floatType:
                  (<any>node).wasmType = floatType;
                  return op.f32.const(constant.value);

                case doubleType:
                  (<any>node).wasmType = doubleType;
                  return op.f64.const(constant.value);

              }
            }
          }
        }

        this.error(node, "Unsupported property access");
      }

      default:
        this.error(node, "Unsupported expression node", ts.SyntaxKind[node.kind]);
    }
  }

  convertValue(node: ts.Node, expr: WasmExpression, fromType: WasmType, toType: WasmType, explicit: boolean) {
    if (fromType.kind === toType.kind)
      return expr;

    const compiler = this;
    const op = this.module;

    function illegalImplicitConversion() {
      compiler.error(node, "Cannot convert from '" + fromType + "' to '" + toType + "' without a cast");
      explicit = true; // report this only once for the topmost node
    }

    (<any>node).wasmType = toType;

    if (fromType === floatType) {

      if (!explicit && toType !== doubleType)
        illegalImplicitConversion();

      switch (toType) {

        case byteType:
        case ushortType:
        case boolType:
          return this.convertValue(node, op.i32.trunc_u.f32(expr), intType, toType, explicit);

        case uintType:
        case uintptrType32:
          return op.i32.trunc_u.f32(expr);

        case sbyteType:
        case shortType:
          return this.convertValue(node, op.i32.trunc_s.f32(expr), intType, toType, explicit);

        case intType:
          return op.i32.trunc_s.f32(expr);

        case ulongType:
        case uintptrType64:
          return op.i64.trunc_u.f32(expr);

        case longType:
          return op.i64.trunc_s.f32(expr);

        // floatType == floatType

        case doubleType:
          return op.f64.promote(expr);

      }

    } else if (fromType === doubleType) {

      if (!explicit) illegalImplicitConversion();

      switch (toType) {

        case byteType:
        case ushortType:
        case boolType:
          return this.convertValue(node, op.i32.trunc_u.f64(expr), intType, toType, explicit);

        case uintType:
        case uintptrType32:
          return op.i32.trunc_u.f64(expr);

        case sbyteType:
        case shortType:
          return this.convertValue(node, op.i32.trunc_s.f64(expr), intType, toType, explicit);

        case intType:
          return op.i32.trunc_s.f64(expr);

        case ulongType:
        case uintptrType64:
          return op.i64.trunc_u.f64(expr);

        case longType:
          return op.i64.trunc_s.f64(expr);

        case floatType:
          return op.f32.demote(expr);

        // doubleType == doubleType

      }

    } else if (toType === floatType) { // int to float

      switch (fromType) {

        case uintType:
        case uintptrType32:
          if (!explicit) illegalImplicitConversion();

        case byteType:
        case ushortType:
        case boolType:
          return op.f32.convert_u.i32(expr);

        case intType:
          if (!explicit) illegalImplicitConversion();

        case sbyteType:
        case shortType:
          return op.f32.convert_s.i32(expr);

        case ulongType:
        case uintptrType64:
          if (!explicit) illegalImplicitConversion();
          return op.f32.convert_u.i64(expr);

        case longType:
          if (!explicit) illegalImplicitConversion();
          return op.f32.convert_s.i64(expr);

      }

    } else if (toType === doubleType) { // int to double

      switch (fromType) {

        case uintType:
        case uintptrType32:
        case byteType:
        case ushortType:
        case boolType:
          return op.f64.convert_u.i32(expr);

        case intType:
        case sbyteType:
        case shortType:
          return op.f64.convert_s.i32(expr);

        case ulongType:
        case uintptrType64:
          if (!explicit) illegalImplicitConversion();
          return op.f64.convert_u.i64(expr);

        case longType:
          if (!explicit) illegalImplicitConversion();
          return op.f64.convert_s.i64(expr);

      }

    } else if (fromType.isInt && toType.isLong) {

      if (toType.isSigned)
        return op.i64.extend_s(expr);
      else
        return op.i64.extend_u(expr);

    } else if (fromType.isLong && toType.isInt) {

      if (!explicit) illegalImplicitConversion();

      expr = op.i32.wrap(expr);
      fromType = fromType.isSigned ? intType : uintType;

      // fallthrough
    }

    // int to other int

    if (fromType.size < toType.size)
      return expr;

    if (!explicit) illegalImplicitConversion();

    if (toType.isSigned) {
      return op.i32.shl(
        op.i32.shr_s(
          expr,
          op.i32.const(toType.shift32)
        ),
        op.i32.const(toType.shift32)
      );
    } else {
      return op.i32.and(
        expr,
        op.i32.const(toType.mask32)
      );
    }
  }

  resolveType(type: ts.TypeNode, acceptVoid: boolean = false): WasmType {
    const text = type.getText();

    switch (text) {
      case "byte": return byteType;
      case "short": return shortType;
      case "ushort": return ushortType;
      case "int": return intType;
      case "uint": return uintType;
      case "long": return longType;
      case "ulong": return ulongType;
      case "bool": return boolType;
      case "float": return floatType;
      case "double": return doubleType;
      case "void": if (acceptVoid) return voidType;
      case "uintptr": return this.uintptrType;
    }

    if (type.kind == ts.SyntaxKind.TypeReference) {
      var reference = <ts.TypeReferenceNode>type;
      switch (reference.typeName.getText()) {
        case "Ptr":
          if (reference.typeArguments.length !== 1)
            throw Error("illegal number of type parameters on Ptr<T>");
          if (reference.typeArguments[0].kind !== ts.SyntaxKind.TypeReference)
            throw Error("unsupported type parameter on Ptr<T>");
          return this.uintptrType.withUnderlyingType(this.resolveType(<ts.TypeReferenceNode>reference.typeArguments[0]));
      }
    }

    throw Error("unsupported type: " + text);
  }
}