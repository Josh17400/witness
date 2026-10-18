// Ways for game code to expose state to Witness snapshots without writing a snapshot function.
using System;

namespace WitnessKit
{
    /// <summary>
    /// Marks a MonoBehaviour as a Witness entity: every enabled instance becomes one element of
    /// state.entities = [{id, type, pos, ...[WitnessState] members}]. pos is transform.position
    /// ([x, y] when <see cref="Is2D"/>). id is a [WitnessState] member named "id"/"Id" if there is one,
    /// otherwise the object's hierarchy path (stable across runs, unlike GetInstanceID()).
    /// </summary>
    [AttributeUsage(AttributeTargets.Class, Inherited = true)]
    public sealed class WitnessEntityAttribute : Attribute
    {
        /// <summary>The entity type for count('Type') / first('Type'); defaults to the class name.</summary>
        public string Type;
        /// <summary>Report pos as [x, y] instead of [x, y, z].</summary>
        public bool Is2D;

        public WitnessEntityAttribute(string type = null) { Type = type; }
    }

    /// <summary>
    /// Includes a field or property in snapshots. On a [WitnessEntity] it becomes an entity field;
    /// on any other MonoBehaviour it appears under state.&lt;ClassName&gt;.&lt;member&gt;.
    /// </summary>
    [AttributeUsage(AttributeTargets.Field | AttributeTargets.Property, Inherited = true)]
    public sealed class WitnessStateAttribute : Attribute
    {
        /// <summary>The JSON key; defaults to the member name.</summary>
        public string Name;

        public WitnessStateAttribute(string name = null) { Name = name; }
    }

    /// <summary>
    /// Implement on a MonoBehaviour to add computed state. Return an IDictionary: its keys are merged
    /// into the snapshot root (or into the entity, for a [WitnessEntity] component).
    /// </summary>
    public interface IWitnessState
    {
        object WitnessState();
    }
}
