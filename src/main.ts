// todo: fix same name variable move bug
// todo: implement move to collection

import { once, showUI, on, emit } from "@create-figma-plugin/utilities";
import { COMMANDS } from "./commands";
import { ID_AND_PATH_DELIMETER } from "./constants";
import {
   AllAliasedVariableValue,
   AllAliasedVariableValuesWithNewVariableId,
} from "./types";

async function getCollectionsWithVariables() {
   const collections = await figma.variables.getLocalVariableCollectionsAsync();

   const withName = collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
   }));

   const variables = figma.variables.getLocalVariables().map((variable) => ({
      id: variable.id,
      name: variable.name,
      resolvedType: variable.resolvedType,
      collectionId: variable.variableCollectionId,
   }));

   const collectionsWithVariables = withName.map((collection) => ({
      ...collection,
      variables: variables.filter(
         (variable) => variable.collectionId === collection.id
      ),
   }));
   return collectionsWithVariables;
}

const fetchCollectionsWithVariables = async () => {
   const collections = await getCollectionsWithVariables();
   emit(COMMANDS.FETCH_COLLECTION_RESULT, collections);
};

export default function () {
   on(COMMANDS.FETCH_COLLECTION_CALL, async function () {
      await fetchCollectionsWithVariables();
   });

   on(
      COMMANDS.DUPLICATE_COLLECTION_CALL,
      async function (collectionId: VariableCollection["id"]) {
         const oldCollection = await figma.variables.getVariableCollectionById(
            collectionId
         );

         if (!oldCollection) {
            figma.notify("Collection not found", { error: true });
            return;
         }

         figma.variables.createVariableCollection(oldCollection.name);

         await fetchCollectionsWithVariables();
      }
   );

   on(COMMANDS.CHANGE_VARIABLE_LOCATION, async function (data) {
      try {
         const { from, to, updateDependencies } = data;

         const [id, path] = from.split(ID_AND_PATH_DELIMETER);

         if (path === "") {
            throw new Error("Path is empty");
         }

         const sourceVariable = figma.variables.getVariableById(id);

         if (!sourceVariable?.variableCollectionId) {
            throw new Error("Variable not found");
         }

         const sourceCollection = figma.variables.getVariableCollectionById(
            sourceVariable?.variableCollectionId
         );

         const targetCollection = figma.variables.getVariableCollectionById(to);

         if (!sourceCollection || !targetCollection) {
            throw new Error("Source or target collection not found");
         }

         const allVariables = figma.variables.getLocalVariables();
         const variablesToMove = allVariables.filter(
            (variable) =>
               variable.variableCollectionId === sourceCollection.id &&
               variable.name.startsWith(path)
         );

         if (variablesToMove.length === 0) {
            figma.notify("No variables found to move", { error: true });
            return;
         }

         const allVariableValues = allVariables.flatMap((variable) =>
            Object.entries(variable.valuesByMode).map(([key, value]) => ({
               variableId: variable.id,
               variableName: variable.name,
               modeId: key,
               value,
            }))
         );

         const allAliasedVariableValues: AllAliasedVariableValue[] =
            allVariableValues
               .filter(
                  (variable) =>
                     typeof variable.value === "object" &&
                     "type" in variable.value &&
                     variable.value.type === "VARIABLE_ALIAS"
               )
               .map(({ value, ...variableWithAliasedValue }) => {
                  const aliasedValueWithType = value as VariableAlias;
                  const aliasedVariableInfo = figma.variables.getVariableById(
                     aliasedValueWithType.id
                  );

                  return {
                     ...variableWithAliasedValue,
                     aliasedValue: {
                        name: aliasedVariableInfo?.name,
                        ...aliasedValueWithType,
                     },
                  };
               });

         const sourceModes = sourceCollection.modes;

         const matchOldModes = sourceModes.map((oldMode) => {
            let newModeId;

            const exists = targetCollection.modes.find(
               (m) => m.name === oldMode.name
            );

            if (!exists) {
               targetCollection.addMode(oldMode.name);
               newModeId = targetCollection.modes.find(
                  (m) => m.name === oldMode.name
               )?.modeId;
            } else {
               newModeId = exists.modeId;
            }

            return {
               oldModeId: oldMode.modeId,
               newModeId,
            };
         });

         let duplicatedVariables: Variable["id"][] = [];

         variablesToMove.forEach((variable) => {
            const valuesByModeArray = Object.entries(variable.valuesByMode).map(
               ([key, value]) => ({ key, value })
            );

            valuesByModeArray.forEach(({ key, value }) => {
               const newModeId = matchOldModes.find(
                  (matchedModes) => matchedModes.oldModeId === key
               )?.newModeId;

               const newCollection =
                  figma.variables.getVariableCollectionById(to);

               if (!newCollection || !newModeId) {
                  figma.notify("Collection not found", { error: true });
                  return;
               }

               const newVariable = figma.variables.createVariable(
                  variable.name,
                  newCollection,
                  variable?.resolvedType
               );

               newVariable.setValueForMode(newModeId, value);
               duplicatedVariables.push(variable.id);

               if (!updateDependencies) {
                  return;
               }

               const references = allAliasedVariableValues
                  .filter(
                     (aliasedVariable) =>
                        variable.id === aliasedVariable.aliasedValue.id
                  )
                  .map(({ aliasedValue, ...rest }) => ({
                     ...rest,
                     collectionName: sourceCollection.name,
                     newVariableId: newVariable.id,
                     newVariableCollectionName: newCollection.name,
                  }));

               emit(COMMANDS.LET_USER_KNOW_ABOUT_DEPENDENCIES, references);
            });
         });

         figma.notify(
            `Succesfully duplicated ${duplicatedVariables.length} variables`
         );
         await fetchCollectionsWithVariables();
         emit(COMMANDS.DUPLICATE_COLLECTION_RESULT, duplicatedVariables);
      } catch (error) {
         if (error instanceof Error) {
            figma.notify(`Error moving variables; ${error.message}`, {
               error: true,
            });
         } else {
            console.error(error);
            figma.notify("Error moving variables", {
               error: true,
            });
         }
      }
   });

   on(
      COMMANDS.UPDATE_VARIABLE_DEPENDENCIES,
      async function (references: AllAliasedVariableValuesWithNewVariableId) {
         references.forEach((reference) => {
            const variableWithAlias = figma.variables.getVariableById(
               reference.variableId
            );

            if (!variableWithAlias) {
               return;
            }

            variableWithAlias.setValueForMode(reference.modeId, {
               type: "VARIABLE_ALIAS",
               id: reference.newVariableId,
            });
         });
      }
   );

   showUI({
      height: 400,
      width: 600,
   });
}
