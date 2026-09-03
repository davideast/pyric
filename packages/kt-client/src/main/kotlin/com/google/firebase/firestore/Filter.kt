package com.google.firebase.firestore

/**
 * A Filter represents a restriction on one or more field values and can be used as a query constraint.
 */
sealed class Filter {

    class Unary internal constructor(
        val fieldPath: FieldPath,
        val operator: Operator,
        val value: Any?
    ) : Filter() {
        enum class Operator(val wireOp: String) {
            EQUAL("=="),
            NOT_EQUAL("!="),
            LESS_THAN("<"),
            LESS_THAN_OR_EQUAL("<="),
            GREATER_THAN(">"),
            GREATER_THAN_OR_EQUAL(">="),
            ARRAY_CONTAINS("array-contains"),
            ARRAY_CONTAINS_ANY("array-contains-any"),
            IN("in"),
            NOT_IN("not-in")
        }
    }

    class Composite internal constructor(
        val operator: Operator,
        val filters: List<Filter>
    ) : Filter() {
        enum class Operator(val wireOp: String) {
            AND("and"),
            OR("or")
        }
    }

    companion object {
        fun equalTo(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.EQUAL, value)

        fun equalTo(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.EQUAL, value)

        fun notEqualTo(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.NOT_EQUAL, value)

        fun notEqualTo(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.NOT_EQUAL, value)

        fun lessThan(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.LESS_THAN, value)

        fun lessThan(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.LESS_THAN, value)

        fun lessThanOrEqualTo(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.LESS_THAN_OR_EQUAL, value)

        fun lessThanOrEqualTo(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.LESS_THAN_OR_EQUAL, value)

        fun greaterThan(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.GREATER_THAN, value)

        fun greaterThan(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.GREATER_THAN, value)

        fun greaterThanOrEqualTo(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.GREATER_THAN_OR_EQUAL, value)

        fun greaterThanOrEqualTo(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.GREATER_THAN_OR_EQUAL, value)

        fun arrayContains(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.ARRAY_CONTAINS, value)

        fun arrayContains(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.ARRAY_CONTAINS, value)

        fun arrayContainsAny(field: String, values: List<Any?>): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.ARRAY_CONTAINS_ANY, values)

        fun arrayContainsAny(fieldPath: FieldPath, values: List<Any?>): Filter =
            Unary(fieldPath, Unary.Operator.ARRAY_CONTAINS_ANY, values)

        fun inArray(field: String, values: List<Any?>): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.IN, values)

        fun inArray(fieldPath: FieldPath, values: List<Any?>): Filter =
            Unary(fieldPath, Unary.Operator.IN, values)

        fun notInArray(field: String, values: List<Any?>): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.NOT_IN, values)

        fun notInArray(fieldPath: FieldPath, values: List<Any?>): Filter =
            Unary(fieldPath, Unary.Operator.NOT_IN, values)

        fun and(vararg filters: Filter): Filter =
            Composite(Composite.Operator.AND, filters.toList())

        fun or(vararg filters: Filter): Filter =
            Composite(Composite.Operator.OR, filters.toList())
    }
}
