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
        @JvmStatic
        fun equalTo(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.EQUAL, value)

        @JvmStatic
        fun equalTo(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.EQUAL, value)

        @JvmStatic
        fun notEqualTo(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.NOT_EQUAL, value)

        @JvmStatic
        fun notEqualTo(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.NOT_EQUAL, value)

        @JvmStatic
        fun lessThan(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.LESS_THAN, value)

        @JvmStatic
        fun lessThan(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.LESS_THAN, value)

        @JvmStatic
        fun lessThanOrEqualTo(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.LESS_THAN_OR_EQUAL, value)

        @JvmStatic
        fun lessThanOrEqualTo(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.LESS_THAN_OR_EQUAL, value)

        @JvmStatic
        fun greaterThan(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.GREATER_THAN, value)

        @JvmStatic
        fun greaterThan(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.GREATER_THAN, value)

        @JvmStatic
        fun greaterThanOrEqualTo(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.GREATER_THAN_OR_EQUAL, value)

        @JvmStatic
        fun greaterThanOrEqualTo(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.GREATER_THAN_OR_EQUAL, value)

        @JvmStatic
        fun arrayContains(field: String, value: Any?): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.ARRAY_CONTAINS, value)

        @JvmStatic
        fun arrayContains(fieldPath: FieldPath, value: Any?): Filter =
            Unary(fieldPath, Unary.Operator.ARRAY_CONTAINS, value)

        @JvmStatic
        fun arrayContainsAny(field: String, values: List<Any?>): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.ARRAY_CONTAINS_ANY, values)

        @JvmStatic
        fun arrayContainsAny(fieldPath: FieldPath, values: List<Any?>): Filter =
            Unary(fieldPath, Unary.Operator.ARRAY_CONTAINS_ANY, values)

        @JvmStatic
        fun inArray(field: String, values: List<Any?>): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.IN, values)

        @JvmStatic
        fun inArray(fieldPath: FieldPath, values: List<Any?>): Filter =
            Unary(fieldPath, Unary.Operator.IN, values)

        @JvmStatic
        fun notInArray(field: String, values: List<Any?>): Filter =
            Unary(FieldPath.fromDotSeparated(field), Unary.Operator.NOT_IN, values)

        @JvmStatic
        fun notInArray(fieldPath: FieldPath, values: List<Any?>): Filter =
            Unary(fieldPath, Unary.Operator.NOT_IN, values)

        @JvmStatic
        fun and(vararg filters: Filter): Filter =
            Composite(Composite.Operator.AND, filters.toList())

        @JvmStatic
        fun or(vararg filters: Filter): Filter =
            Composite(Composite.Operator.OR, filters.toList())
    }
}
