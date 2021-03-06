/** @module assemblyscript/expressions */ /** */

import * as ts from "../typescript";
import { Expression } from "binaryen";
import { Compiler } from "../compiler";
import { Type, ReflectionObjectKind, VariableBase, LocalVariable } from "../reflection";
import { getReflectedType, setReflectedType } from "../util";

/** Compiles a unary prefix expression. */
export function compilePrefixUnary(compiler: Compiler, node: ts.PrefixUnaryExpression, contextualType: Type): Expression {
  const op = compiler.module;

  const operand = compiler.compileExpression(node.operand, contextualType);
  const operandType = getReflectedType(node.operand);

  switch (node.operator) {

    case ts.SyntaxKind.ExclamationToken:
    {
      setReflectedType(node, Type.bool);

      if (operandType === Type.f32)
        return op.f32.eq(operand, op.f32.const(0));

      else if (operandType === Type.f64)
        return op.f64.eq(operand, op.f64.const(0));

      else if (operandType.isLong)
        return op.i64.eqz(operand);

      else
        return op.i32.eqz(operand);
    }

    case ts.SyntaxKind.PlusToken: // noop
    {
      setReflectedType(node, operandType);
      return operand;
    }

    case ts.SyntaxKind.MinusToken:
    {
      setReflectedType(node, operandType);

      if (node.operand.kind === ts.SyntaxKind.NumericLiteral)
        return operand; // implicitly compiled the negated form previously, see expressions.ts case typescript.SyntaxKind.NumericLiteral

      if (operandType === Type.f32)
        return op.f32.neg(operand);

      else if (operandType === Type.f64)
        return op.f64.neg(operand);

      else if (operandType.isLong)
        return op.i64.sub(op.i64.const(0, 0), operand);

      else
        return compiler.maybeConvertValue(node, op.i32.sub(op.i32.const(0), operand), Type.i32, operandType, true);
    }

    case ts.SyntaxKind.TildeToken:
    {
      if (operandType.isLong) {

        setReflectedType(node, operandType);
        return op.i64.xor(operand, op.i64.const(-1, -1));

      } else if (operandType.isInt) {

        setReflectedType(node, operandType);
        return op.i32.xor(operand, op.i32.const(-1));

      } else if (contextualType.isLong) { // TODO: is the following correct / doesn't generate useless ops?

        setReflectedType(node, contextualType);
        return op.i64.xor(compiler.maybeConvertValue(node.operand, operand, operandType, contextualType, true), op.i64.const(-1, -1));

      } else {

        setReflectedType(node, Type.i32);
        return op.i32.xor(compiler.maybeConvertValue(node.operand, operand, operandType, Type.i32, true), op.i32.const(-1));

      }
    }

    case ts.SyntaxKind.PlusPlusToken:
    case ts.SyntaxKind.MinusMinusToken:
    {
      if (node.operand.kind === ts.SyntaxKind.Identifier) {

        const reference = compiler.resolveReference(<ts.Identifier>node.operand, ReflectionObjectKind.LocalVariable | ReflectionObjectKind.GlobalVariable);
        if (reference instanceof VariableBase) {
          const variable = <VariableBase>reference;

          const cat = compiler.categoryOf(variable.type);
          const isIncrement = node.operator === ts.SyntaxKind.PlusPlusToken;
          const binaryenType = compiler.typeOf(variable.type);

          const calculate = (isIncrement ? cat.add : cat.sub).call(cat,
            variable instanceof LocalVariable
              ? op.getLocal(
                  variable.index,
                  binaryenType
                )
              : op.getGlobal(
                  variable.name,
                  binaryenType
                ),
            compiler.valueOf(variable.type, 1)
          );

          if (contextualType === Type.void) {
            setReflectedType(node, Type.void);
            return variable instanceof LocalVariable
              ? op.setLocal(variable.index, calculate)
              : op.setGlobal(variable.name, calculate);
          }

          setReflectedType(node, variable.type);
          return variable instanceof LocalVariable
            ? op.teeLocal(variable.index, calculate)
            : op.block("", [
                op.setGlobal(variable.name, calculate),
                op.getGlobal(variable.name, binaryenType)
              ], binaryenType);
        }
      }
    }
  }

  compiler.report(node, ts.DiagnosticsEx.Unsupported_node_kind_0_in_1, node.operator, "expressions.compilePrefixUnary");
  return op.unreachable();
}

export default compilePrefixUnary;
